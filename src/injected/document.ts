/*
  Content script are run in an isolated DOM so it is not possible to access some key details that are sanitized when passed cross-dom
  This script is used to get the details from the page and make them available for the content script by being injected directly into the page
*/

import { PageType } from "../video";

interface StartMessage {
    type: "navigation";
    pageType: PageType;
    videoID: string | null;
}

interface FinishMessage extends StartMessage {
    channelID: string;
    channelTitle: string;
}

interface AdMessage {
    type: "ad";
    playing: boolean;
}

interface VideoData {
    type: "data";
    videoID: string;
    isLive: boolean;
    isPremiere: boolean;
}

interface ElementCreated {
    type: "newElement";
    name: string;
}

interface VideoIDsLoadedCreated {
    type: "videoIDsLoaded";
    videoIDs: string[];
}

type WindowMessage = StartMessage | FinishMessage | AdMessage | VideoData | ElementCreated | VideoIDsLoadedCreated;

declare const ytInitialData: Record<string, string> | undefined;

// global playerClient - too difficult to type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let playerClient: any;
let lastVideo = "";
const id = "sponsorblock";
const elementsToListenFor = ["ytd-thumbnail"];

// From BlockTube https://github.com/amitbl/blocktube/blob/9dc6dcee1847e592989103b0968092eb04f04b78/src/scripts/seed.js#L52-L58
const fetchUrlsToRead = [
    "/youtubei/v1/search",
    "/youtubei/v1/guide",
    "/youtubei/v1/browse",
    "/youtubei/v1/next",
    "/youtubei/v1/player"
];

// To not get update data for the current videoID, that is already
// collected using other methods
const ytInfoKeysToIgnore = [
    "videoDetails",
    "videoPrimaryInfoRenderer",
    "videoSecondaryInfoRenderer",
    "currentVideoEndpoint"
];

const sendMessage = (message: WindowMessage): void => {
    window.postMessage({ source: id, ...message }, "/");
}

function setupPlayerClient(e: CustomEvent): void {
    if (playerClient) return; // early exit if already defined
    
    playerClient = e.detail;
    sendVideoData(); // send playerData after setup

    e.detail.addEventListener('onAdStart', () => sendMessage({ type: "ad", playing: true } as AdMessage));
    e.detail.addEventListener('onAdFinish', () => sendMessage({ type: "ad", playing: false } as AdMessage));
}

function navigationParser(event: CustomEvent): StartMessage | null {
    const pageType: PageType = event.detail.pageType;
    if (pageType) {
        const result: StartMessage = { type: "navigation", pageType, videoID: null };
        if (pageType === "shorts" || pageType === "watch") {
            const endpoint = event.detail.endpoint
            if (!endpoint) return null;
            
            result.videoID = (pageType === "shorts" ? endpoint.reelWatchEndpoint : endpoint.watchEndpoint).videoId;
        }

        return result;
    } else {
        return null;
    }
}

function navigationStartSend(event: CustomEvent): void {
    const message = navigationParser(event) as StartMessage;
    if (message) {
        sendMessage(message);
    }
}

function navigateFinishSend(event: CustomEvent): void {
    sendVideoData(); // arrived at new video, send video data
    const videoDetails = event.detail?.response?.playerResponse?.videoDetails;
    if (videoDetails) {
        sendMessage({ channelID: videoDetails.channelId, channelTitle: videoDetails.author, ...navigationParser(event) } as FinishMessage);
    }
}

function sendVideoData(): void {
    if (!playerClient) return;
    const videoData = playerClient.getVideoData();
    if (videoData && videoData.video_id !== lastVideo) {
        lastVideo = videoData.video_id;
        sendMessage({ type: "data", videoID: videoData.video_id, isLive: videoData.isLive, isPremiere: videoData.isPremiere } as VideoData);
    }
}

function onNewVideoIds(data: Record<string, unknown>) {
    sendMessage({
        type: "videoIDsLoaded",
        videoIDs: Array.from(findAllVideoIds(data))
    });
}

function findAllVideoIds(data: Record<string, unknown>): Set<string> {
    const videoIds: Set<string> = new Set();
    
    for (const key in data) {
        if (key === "videoId") {
            videoIds.add(data[key] as string);
        } else if (typeof(data[key]) === "object" && !ytInfoKeysToIgnore.includes(key)) {
            findAllVideoIds(data[key] as Record<string, unknown>).forEach(id => videoIds.add(id));
        }
    }

    return videoIds;
}

// WARNING: Putting any parameters here will not work because SponsorBlock and the clickbait extension share document scripts
// Only one will exist on the page at a time
export function init(): void {
    document.addEventListener("yt-player-updated", setupPlayerClient);
    document.addEventListener("yt-navigate-start", navigationStartSend);
    document.addEventListener("yt-navigate-finish", navigateFinishSend);

    if (["m.youtube.com", "www.youtube.com", "www.youtube-nocookie.com", "music.youtube.com"].includes(window.location.host)) {
        // If customElement.define() is native, we will be given a class constructor and should extend it.
        // If it is not native, we will be given a function and should wrap it.
        const isDefineNative = window.customElements.define.toString().indexOf("[native code]") !== -1
        const realCustomElementDefine = window.customElements.define.bind(window.customElements);
        window.customElements.define = (name: string, constructor: CustomElementConstructor, options: ElementDefinitionOptions) => {
            let replacedConstructor: CallableFunction = constructor;
            if (elementsToListenFor.includes(name)) {
                if (isDefineNative) {
                    class WrappedThumbnail extends constructor {
                        constructor() {
                            super();
                            sendMessage({ type: "newElement", name })
                        }
                    }
                    replacedConstructor = WrappedThumbnail;
                } else {
                    // based on https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/new.target#new.target_using_reflect.construct
                    // clearly marked as bad practice, but it works lol
                    replacedConstructor = function () {
                        constructor.call(this);
                        sendMessage({ type: "newElement", name })
                    };
                    Object.setPrototypeOf(replacedConstructor.prototype, constructor.prototype);
                    Object.setPrototypeOf(replacedConstructor, constructor);
                }
            }

            realCustomElementDefine(name, replacedConstructor, options);
        }
    }

    // Hijack fetch to know when new videoIDs are loaded
    const browserFetch = window.fetch;
    window.fetch = (resource, init=undefined) => {
        if (!(resource instanceof Request) || !fetchUrlsToRead.some(u => resource.url.includes(u))) {
            return browserFetch(resource, init);
        }

        // eslint-disable-next-line @typescript-eslint/no-misused-promises, no-async-promise-executor
        return new Promise(async (resolve, reject) => {
            try {
                const response = await browserFetch(resource, init=init);
                //   const url = new URL(resource.url);
                const json = await response.json();

                // A new response has to be made because the body can only be read once
                resolve(new Response(JSON.stringify(json), response));

                onNewVideoIds(json);
            } catch (e) {
                reject(e);
            }
        });
    }

    if (typeof(ytInitialData) !== "undefined") {
        onNewVideoIds(ytInitialData);
    } else {
        // Wait until it is loaded in
        const waitingInterval = setInterval(() => {
            if (typeof(ytInitialData) !== "undefined") {
                onNewVideoIds(ytInitialData);
                clearInterval(waitingInterval);
            }
        }, 1);
    }
}