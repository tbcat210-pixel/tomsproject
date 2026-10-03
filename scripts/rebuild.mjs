import { readJson } from './lib.mjs';
import { loadConfig, mergePosts, paths, saveSnapshot } from './collector-core.mjs';

const { cardsConfig, queryConfig, historyConfig } = await loadConfig();
const now = new Date();
const state = await readJson(paths.state, {});
const rawPosts = await readJson(paths.posts, []);
const posts = mergePosts([], rawPosts, now, historyConfig.storageHorizonHours ?? 192);
await saveSnapshot({ now, posts, cardsConfig, queryConfig, state, discoveredThisRun: 0, errors: [] });
