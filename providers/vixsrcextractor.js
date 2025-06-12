const cheerio = require('cheerio');
const fetch = require('node-fetch');
const vm = require('vm');

// --- Constants ---
const VIXSRC_PROXY_URL = process.env.VIXSRC_PROXY_URL;
const SOURCE_URL = "https://vixsrc.to";

// --- Helper: Proxied Fetch ---
async function fetchWrapper(url, options) {
    if (VIXSRC_PROXY_URL) {
        const proxiedUrl = `${VIXSRC_PROXY_URL}${encodeURIComponent(url)}`;
        return fetch(proxiedUrl, options);
    }
    return fetch(url, options);
}

// --- Main Exported Function ---
async function getVixStreamContent(tmdbId, mediaType, seasonNum = null, episodeNum = null) {
    console.log(`[VixSrc] Starting definitive process for TMDB ID: ${tmdbId}`);

    const landingUrl = mediaType === 'movie'
        ? `${SOURCE_URL}/movie/${tmdbId}`
        : `${SOURCE_URL}/tv/${tmdbId}/${seasonNum}/${episodeNum}`;

    console.log(`[VixSrc] Fetching landing page: ${landingUrl}`);

    try {
        const response = await fetchWrapper(landingUrl, {
            headers: {
                "Referer": SOURCE_URL + "/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            }
        });
        if (!response.ok) {
            console.error(`[VixSrc] Failed to fetch landing page ${landingUrl}: ${response.status}`);
            return [];
        }
        const html = await response.text();

        const $ = cheerio.load(html);
        let dataScriptContent = null;
        $('script').each((i, el) => {
            const scriptText = $(el).html();
            if (scriptText && scriptText.includes('window.masterPlaylist')) {
                dataScriptContent = scriptText;
                return false;
            }
        });

        if (!dataScriptContent) {
            console.log(`[VixSrc] Could not find the data script on the page.`);
            return [];
        }

        const sandbox = { window: {} };
        vm.createContext(sandbox);
        vm.runInContext(dataScriptContent, sandbox);

        const { masterPlaylist, video } = sandbox.window;

        if (!masterPlaylist || !masterPlaylist.params || !video || !video.id) {
            console.error('[VixSrc] Failed to parse required objects (masterPlaylist, video.id) from script.');
            return [];
        }

        const playlistId = video.id;
        const tokenParams = new URLSearchParams(masterPlaylist.params);

        tokenParams.append('h', '1');
        tokenParams.append('lang', 'en');

        const masterPlaylistUrl = `${SOURCE_URL}/playlist/${playlistId}?${tokenParams.toString()}`;
        console.log(`[VixSrc] Constructed master playlist URL for player: ${masterPlaylistUrl}`);

        // --- NEW: Fetch playlist to extract audio languages for the title ---
        let audioTitle = "🎧 Multi-Audio & Subtitles"; // Default/fallback title

        try {
            const playlistResponse = await fetchWrapper(masterPlaylistUrl, { headers: { "Referer": landingUrl } });
            if (playlistResponse.ok) {
                const playlistContent = await playlistResponse.text();
                const lines = playlistContent.split('\n');
                const audioLangs = [];

                for (const line of lines) {
                    if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
                        const langMatch = line.match(/LANGUAGE="([^"]+)"/);
                        if (langMatch && langMatch[1]) {
                            const lang = langMatch[1].toUpperCase();
                            if (!audioLangs.includes(lang)) {
                                audioLangs.push(lang);
                            }
                        }
                    }
                }

                if (audioLangs.length > 0) {
                    audioTitle = `🎧 Multi-Audio: ${audioLangs.join(' | ')}`;
                }
            } else {
                console.warn(`[VixSrc] Could not fetch playlist to get audio languages, using default title.`);
            }
        } catch (err) {
            console.error(`[VixSrc] Error fetching playlist for audio languages: ${err.message}. Using default title.`);
        }
        // --- End of new section ---

        const stream = {
            name: "VixSrc",
            title: `▶️ Auto-Select\n${audioTitle}`, // Use the new dynamic title
            url: masterPlaylistUrl,
            type: 'url',
            behaviorHints: {
                proxyHeaders: {
                    "request": {
                        "Referer": landingUrl
                    }
                },
                notWebReady: true
            }
        };

        console.log(`[VixSrc] Successfully created stream object for master playlist.`);
        return [stream];

    } catch (error) {
        console.error(`[VixSrc] A critical error occurred:`, error);
        return [];
    }
}

module.exports = { getVixStreamContent };