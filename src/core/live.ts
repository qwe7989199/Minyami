import Downloader, { Chunk, LiveDownloaderConfig } from "./downloader";
import M3U8, { M3U8Chunk } from "./m3u8";
import { ConsoleLogger } from "../utils/log";
import { mergeToMKV, mergeToTS } from "../utils/media";
import { sleep } from "../utils/system";
import { URL } from "url";
import { AxiosRequestConfig } from "axios";
import { loadM3U8 } from "../utils/m3u8";
const path = require("path");
const fs = require("fs");
const os = require("os");

/**
 * Live Downloader
 */

export default class LiveDownloader extends Downloader {
    outputFileList: string[] = [];
    finishedList: string[] = [];
    m3u8: M3U8;
    chunks: Chunk[] = [];
    runningThreads: number = 0;

    isEncrypted: boolean = false;
    isEnd: boolean = false;
    isStarted: boolean = false;
    forceStop: boolean = false;

    prefix: string;

    retries = 3;

    /**
     *
     * @param m3u8Path
     * @param config
     * @param config.threads 线程数量
     */
    constructor(
        m3u8Path: string,
        {
            threads,
            output,
            key,
            verbose,
            retries,
            proxy,
            cookies,
            headers,
            nomerge,
            logger,
            cliMode,
        }: LiveDownloaderConfig
    ) {
        super(logger || new ConsoleLogger(), m3u8Path, {
            threads: threads || 5,
            output,
            key,
            verbose,
            retries,
            proxy,
            cookies,
            headers,
            nomerge,
            cliMode,
        });
        if (retries) {
            this.retries = retries;
        }
    }

    async loadM3U8() {
        try {
            const options: AxiosRequestConfig = {};
            if (this.cookies) {
                options.headers = {
                    Cookie: this.cookies,
                };
            }
            if (Object.keys(this.headers).length > 0) {
                options.headers = this.headers;
            }
            this.m3u8 = await loadM3U8(
                this.Log,
                this.m3u8Path,
                this.retries,
                this.timeout,
                this.proxy ? { host: this.proxyHost, port: this.proxyPort } : undefined,
                options
            );
        } catch (e) {
            if (this.finishedChunksCount > 0) {
                // Stop downloading
                this.isEnd = true;
            } else {
                this.emit("critical-error");
                this.Log.error("Aborted due to critical error.", e);
            }
        }
    }

    async download() {
        // Record start time to calculate speed.
        this.startedAt = new Date().valueOf();
        // Allocate temporary directory.
        this.tempPath = path.resolve(os.tmpdir(), "minyami_" + new Date().valueOf());

        if (!fs.existsSync(this.tempPath)) {
            fs.mkdirSync(this.tempPath);
        }

        if (this.cliMode) {
            process.on("SIGINT", async () => {
                if (!this.forceStop) {
                    this.Log.info("Ctrl+C pressed, waiting for tasks finished.");
                    this.isEnd = true;
                    this.forceStop = true;
                } else {
                    this.Log.info("Force stop."); // TODO: reject all download promises
                    this.emit("finished");
                }
            });
        }

        await this.loadM3U8();

        this.timeout = Math.max(20000, this.m3u8.chunks.length * this.m3u8.getChunkLength() * 1000);

        if (this.m3u8.isEncrypted) {
            this.isEncrypted = true;
            const key = this.m3u8.key;
            if (key.startsWith("abematv-license")) {
                this.Log.info("Site comfirmed: AbemaTV");
                const parser = await import("./parsers/abema");
                parser.default.parse({
                    downloader: this,
                });
                this.Log.info(`Key: ${this.key}; IV: ${this.m3u8.iv}.`);
            } else {
                this.Log.warning(`Site is not supported by Minyami Core. Try common parser.`);
                const parser = await import("./parsers/common");
                await parser.default.parse({
                    downloader: this,
                });
            }
        } else {
            this.isEncrypted = false;
            // Not encrypted
            if (this.m3u8Path.includes("dmc.nico")) {
                this.Log.info("Site comfirmed: Niconico.");
                const parser = await import("./parsers/nicolive");
                parser.default.parse({
                    downloader: this,
                });
            } else if (this.m3u8Path.includes("googlevideo")) {
                // YouTube
                this.Log.info("Site comfirmed: YouTube.");
                const parser = await import("./parsers/youtube");
                parser.default.parse({
                    downloader: this,
                });
            } else {
                this.Log.warning(`Site is not supported by Minyami Core. Try common parser.`);
                const parser = await import("./parsers/common");
                await parser.default.parse({
                    downloader: this,
                });
            }
        }
        this.emit("parsed");
        if (this.verbose) {
            setInterval(() => {
                this.Log.debug(
                    `Now running threads: ${this.runningThreads}, finished chunks: ${this.finishedChunksCount}`
                );
            }, 3000);
        }
        await this.cycling();
    }

    async cycling() {
        while (true) {
            if (this.isEnd) {
                // 结束下载 进入合并流程
                break;
            }
            if (this.m3u8.isEnd) {
                // 到达直播末尾
                this.isEnd = true;
            }
            const currentPlaylistChunks: M3U8Chunk[] = [];
            this.m3u8.chunks.forEach((chunk) => {
                try {
                    // 去重
                    if (
                        !this.finishedList.includes(
                            this.onChunkNaming ? this.onChunkNaming(chunk) : chunk.url
                        )
                    ) {
                        this.finishedList.push(
                            this.onChunkNaming ? this.onChunkNaming(chunk) : chunk.url
                        );
                        currentPlaylistChunks.push(chunk);
                    }
                } catch (e) {
                    // 无法正确命名块 忽略错误
                    // pass
                }
            });
            this.Log.debug(`Get ${currentPlaylistChunks.length} new chunk(s).`);
            const currentUndownloadedChunks = currentPlaylistChunks.map((chunk) => {
                // TODO: Hot fix of Abema Live
                if (chunk.url.includes("linear-abematv")) {
                    if (chunk.url.includes("tsad")) {
                        return undefined;
                    }
                }
                return {
                    filename: this.onChunkNaming
                        ? this.onChunkNaming(chunk)
                        : new URL(chunk.url).pathname.split("/").slice(-1)[0],
                    isEncrypted: this.m3u8.isEncrypted,
                    key: chunk.key,
                    iv: chunk.iv,
                    sequenceId: chunk.sequenceId,
                    url: chunk.url,
                } as Chunk;
            });
            // 加入待完成的任务列表
            this.chunks.push(...currentUndownloadedChunks.filter((c) => c !== undefined));
            this.outputFileList.push(
                ...currentUndownloadedChunks
                    .filter((c) => c !== undefined)
                    .map((chunk) => {
                        if (this.m3u8.isEncrypted) {
                            return path.resolve(this.tempPath, `./${chunk.filename}.decrypt`);
                        } else {
                            return path.resolve(this.tempPath, `./${chunk.filename}`);
                        }
                    })
            );

            await this.loadM3U8();

            if (!this.isStarted) {
                this.isStarted = true;
                this.checkQueue();
            }
            this.Log.debug(`Cool down... Wait for next check`);
            await sleep(Math.min(5000, this.m3u8.getChunkLength() * 1000));
        }
    }

    checkQueue() {
        if (this.chunks.length > 0 && this.runningThreads < this.threads) {
            const task = this.chunks.shift();
            this.runningThreads++;
            this.handleTask(task)
                .then(() => {
                    this.finishedChunksCount++;
                    this.runningThreads--;
                    const currentChunkInfo = {
                        taskname: task.filename,
                        finishedChunksCount: this.finishedChunksCount,
                        chunkSpeed: this.calculateSpeedByChunk(),
                        ratioSpeed: this.calculateSpeedByRatio(),
                    };

                    this.Log.info(
                        `Proccessing ${currentChunkInfo.taskname} finished. (${currentChunkInfo.finishedChunksCount} / unknown | Avg Speed: ${currentChunkInfo.chunkSpeed} chunks/s or ${currentChunkInfo.ratioSpeed}x)`
                    );
                    this.emit("chunk-downloaded", currentChunkInfo);
                    this.checkQueue();
                })
                .catch((e) => {
                    this.emit("chunk-error", e);
                    // 重试计数
                    if (task.retryCount) {
                        task.retryCount++;
                    } else {
                        task.retryCount = 1;
                    }
                    this.Log.warning(`Processing ${task.filename} failed.`);
                    this.Log.debug(e.message);
                    this.runningThreads--;
                    this.chunks.unshift(task); // 对直播流来说 早速重试比较好
                    this.checkQueue();
                });
            this.checkQueue();
        }
        if (this.chunks.length === 0 && this.runningThreads === 0 && this.isEnd) {
            // 结束状态 合并文件
            this.emit("downloaded");
            if (this.noMerge) {
                this.Log.info("Skip merging. Please merge video chunks manually.");
                this.Log.info(`Temporary files are located at ${this.tempPath}`);
                this.emit("finished");
            }
            this.Log.info(`${this.finishedChunksCount} chunks downloaded. Start merging chunks.`);
            const muxer = this.format === "ts" ? mergeToTS : mergeToMKV;
            muxer(this.outputFileList, this.outputPath)
                .then(async () => {
                    this.Log.info("End of merging.");
                    await this.clean();
                    this.Log.info(
                        `All finished. Check your file at [${path.resolve(this.outputPath)}] .`
                    );
                    this.emit("finished");
                })
                .catch((e) => {
                    this.emit("critical-error", e);
                    this.Log.error("Fail to merge video. Please merge video chunks manually.", e);
                    this.Log.error(
                        `Your temporary files at located at [${path.resolve(this.tempPath)}]`
                    );
                });
        }

        if (this.chunks.length === 0 && this.runningThreads === 0 && !this.isEnd) {
            // 空闲状态 一秒后再检查待完成任务列表
            this.Log.debug("Sleep 1000ms.");
            sleep(1000).then(() => {
                this.checkQueue();
            });
        }
    }
}
