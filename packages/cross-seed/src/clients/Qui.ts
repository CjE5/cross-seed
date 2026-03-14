import { link, mkdir } from "fs/promises";
import { dirname, join } from "path";
import ms from "ms";
import { DecisionAnyMatch, InjectionResult } from "../constants.js";
import { Label, logger } from "../logger.js";
import { Metafile } from "../parseTorrent.js";
import { Searchee } from "../searchee.js";
import { getLogString, wait } from "../utils.js";
import QBittorrent from "./QBittorrent.js";

export default class Qui extends QBittorrent {
	override readonly clientType = Label.QUI;

	private readonly quiTag: string | undefined;

	constructor(
		url: string,
		clientHost: string,
		priority: number,
		readonly: boolean,
	) {
		const parsed = new URL(url);
		const tag = parsed.searchParams.get("tag") ?? undefined;
		parsed.searchParams.delete("tag");
		super(parsed.href, clientHost, priority, readonly);
		this.quiTag = tag;
		// Override the label set by QBittorrent constructor to show correct client type
		(this as { label: string }).label = `${Label.QUI}@${this.clientHost}`;
	}

	override async login(): Promise<void> {
		// Qui's proxy doesn't issue Set-Cookie; set a placeholder so inherited
		// request() has a cookie header to send.
		this.cookie = "qui";
	}

	override async validateConfig(): Promise<void> {
		await this.login();
		await this.createTag();
	}

	override async resumeInjection(): Promise<void> {
		// Files are already hardlinked and verified on add; nothing to resume.
	}

	override async inject(
		newTorrent: Metafile,
		searchee: Searchee,
		_decision: DecisionAnyMatch,
		options: { onlyCompleted: boolean; destinationDir?: string },
	): Promise<InjectionResult> {
		const torrentLog = getLogString(newTorrent);
		logger.info({
			label: this.label,
			message: `inject() called for ${torrentLog}`,
		});

		// 1. Deduplication — inherited isTorrentInClient goes through proxy
		const existsRes = await this.isTorrentInClient(newTorrent.infoHash);
		if (existsRes.isErr()) return InjectionResult.FAILURE;
		if (existsRes.unwrap()) return InjectionResult.ALREADY_EXISTS;

		// 2. Source completeness — inherited isTorrentComplete goes through proxy
		if (options.onlyCompleted && searchee.infoHash) {
			const completeRes = await this.isTorrentComplete(searchee.infoHash);
			if (completeRes.isErr() || !completeRes.unwrap()) {
				return InjectionResult.TORRENT_NOT_COMPLETE;
			}
		}

		// 3. Resolve tracker → category from qui's indexer-categories proxy endpoint.
		// trackers[] stores URL.host (e.g. "tracker.blutopia.cc:2710"), not a full URL.
		// Prepend a dummy scheme so URL can parse out just the hostname.
		const trackerHost = newTorrent.trackers[0]
			? new URL(`http://${newTorrent.trackers[0]}`).hostname
			: undefined;

		logger.info({
			label: this.label,
			message: `${torrentLog}: tracker host = ${trackerHost ?? "(none)"}`,
		});

		let resolvedCategory: string | undefined;
		let categoryPath: string | undefined;

		if (trackerHost) {
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					if (attempt > 0) {
						await wait(ms("2 seconds"));
					}
					const catRes = await fetch(
						`${this.url.href}/cross-seed/indexer-categories`,
						{ signal: AbortSignal.timeout(ms("10 seconds")) },
					);
					logger.info({
						label: this.label,
						message: `${torrentLog}: indexer-categories response ${catRes.status}`,
					});
					if (catRes.ok) {
						const mappings = (await catRes.json()) as Array<{
							indexerName: string;
							category: string;
						}>;
						logger.info({
							label: this.label,
							message: `${torrentLog}: ${mappings.length} mappings, looking for "${trackerHost}"`,
						});
						// Normalize for flexible matching: strip dots/dashes/underscores/spaces
						const hostNorm = trackerHost
							.toLowerCase()
							.replace(/[.\-_\s]/g, "");
						const match = mappings.find((m) => {
							const nameNorm = m.indexerName
								.toLowerCase()
								.replace(/[.\-_\s]/g, "");
							// 1. Exact case-insensitive match
							if (
								m.indexerName.toLowerCase() ===
								trackerHost.toLowerCase()
							)
								return true;
							// 2. Hostname (normalized, no dots) contains indexer name
							//    e.g. "trackerbeyondhdco" contains "beyondhd"
							if (hostNorm.includes(nameNorm)) return true;
							// 3. Indexer name contains hostname-without-TLD (less common)
							if (nameNorm.includes(hostNorm)) return true;
							return false;
						});
						if (match?.category) {
							logger.info({
								label: this.label,
								message: `${torrentLog}: matched indexer "${match.indexerName}" → category "${match.category}"`,
							});
							resolvedCategory = match.category;
						}
					}
					break;
				} catch (e) {
					logger.warn({
						label: this.label,
						message: `Failed to fetch indexer-categories (attempt ${attempt + 1}/2): ${e.message}`,
					});
				}
			}
		}

		// 4. No per-tracker mapping — fall back to standard cross-seed behavior
		if (!resolvedCategory) {
			logger.info({
				label: this.label,
				message: `${torrentLog}: no category mapping for "${trackerHost}", falling back to QBittorrent inject`,
			});
			return super.inject(newTorrent, searchee, _decision, options);
		}

		logger.info({
			label: this.label,
			message: `${torrentLog}: resolved category "${resolvedCategory}" for tracker "${trackerHost}"`,
		});

		// 5. Resolve category save path via proxy
		try {
			const catsRes = await fetch(
				`${this.url.href}/torrents/categories`,
				{ signal: AbortSignal.timeout(ms("10 seconds")) },
			);
			if (catsRes.ok) {
				const cats = (await catsRes.json()) as Record<
					string,
					{ savePath: string }
				>;
				categoryPath = cats[resolvedCategory]?.savePath;
				logger.info({
					label: this.label,
					message: `${torrentLog}: category "${resolvedCategory}" save path = "${categoryPath ?? "(not found)"}"`,
				});
			} else {
				logger.error({
					label: this.label,
					message: `${torrentLog}: /torrents/categories returned ${catsRes.status}`,
				});
			}
		} catch (e) {
			logger.error({
				label: this.label,
				message: `Failed to fetch categories: ${e.message}`,
			});
		}

		// If category has no save path configured, fall back
		if (!categoryPath) {
			logger.info({
				label: this.label,
				message: `${torrentLog}: no save path for category "${resolvedCategory}", falling back to QBittorrent inject`,
			});
			return super.inject(newTorrent, searchee, _decision, options);
		}

		// 6. Hardlink source files to category save path
		if (searchee.savePath) {
			try {
				for (const file of newTorrent.files) {
					// searchee.files reflects actual on-disk layout (no root dir for
					// single-file torrents), while newTorrent.files may include the
					// torrent name as a root folder.  Match by filename so the src path
					// points to where the bytes actually live on disk.
					const srcFile = searchee.files.find(
						(f) => f.name === file.name,
					);
					const srcRelPath = srcFile ? srcFile.path : file.path;
					const src = join(searchee.savePath, srcRelPath);
					const dst = join(categoryPath, file.path);
					await mkdir(dirname(dst), { recursive: true });
					await link(src, dst).catch((e) => {
						if (e.code !== "EEXIST") throw e;
					});
				}
			} catch (e) {
				logger.error({
					label: this.label,
					message: `hardlink failed: ${e.message}`,
				});
				return InjectionResult.FAILURE;
			}
		}

		// 7. Add torrent via the proxy's qBittorrent add endpoint
		try {
			const formData = new FormData();
			formData.append(
				"torrents",
				new Blob([newTorrent.encode()]),
				`${newTorrent.name}.torrent`,
			);
			formData.append("category", resolvedCategory);
			formData.append("autoTMM", "true");
			formData.append("skip_checking", "true");
			if (this.quiTag) formData.append("tags", this.quiTag);

			const res = await fetch(`${this.url.href}/torrents/add`, {
				method: "POST",
				body: formData,
				signal: AbortSignal.timeout(ms("30 seconds")),
			});
			if (res.ok) return InjectionResult.SUCCESS;
			logger.error({
				label: this.label,
				message: `qui add returned ${res.status} for ${getLogString(newTorrent)}`,
			});
			return InjectionResult.FAILURE;
		} catch (e) {
			logger.error({
				label: this.label,
				message: `qui inject failed for ${getLogString(newTorrent)}: ${e.message}`,
			});
			return InjectionResult.FAILURE;
		}
	}
}
