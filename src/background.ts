// background.ts (MV3 SW)
import { pipeline, env, Tensor } from '@huggingface/transformers';
import { saveCentroids, loadCentroids as loadCentroidsFromStorage } from './storage';

// 1) モデル選択（まずは軽量＆多言語安定の MiniLM、E5に差し替えも可）
const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
// 例: const MODEL = 'Xenova/multilingual-e5-small';

// 2) WebGPU がダメでも WASM に自動フォールバック
const DEVICE: 'webgpu' | 'wasm' = 'wasm';

// 3) ローカル同梱に切り替える場合
// env.allowLocalModels = true;
// env.localModelPath = chrome.runtime.getURL('models/');

let extractorPromise: ReturnType<typeof pipeline> | null = null;
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL, { device: DEVICE });
  }
  return extractorPromise;
}

function l2norm(x: number[]) {
  const s = Math.sqrt(x.reduce((a, b) => a + b * b, 0)) || 1;
  return x.map(v => v / s);
}
function cosine(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// E5 を使うなら prefix をここで付ける（非対称: query vs passage）
const withPrefix = (text: string, kind: 'query' | 'passage') =>
  MODEL.includes('multilingual-e5') ? `${kind}: ${text}` : text;

async function embed(texts: string[], kind: 'query' | 'passage' = 'passage') {
  const extractor = await getExtractor();
  // mean pooling + L2 正規化（Transformers.js v3 はオプション指定が可能）
  const output = await extractor(texts.map(t => withPrefix(t, kind)), {
    pooling: 'mean',
    normalize: true
  }) as Tensor | Tensor[];
  const arr = Array.isArray(output) ? output : [output];
  return arr.map(t => Array.from(t.data as Float32Array));
}

// ------------- フォルダのベクトル（タイトル群の平均） -------------
export type FolderVec = { folderId: string; name: string; vec: number[]; size: number };

async function buildFolderCentroids(): Promise<FolderVec[]> {
  const tree = await chrome.bookmarks.getTree();
  const folders: chrome.bookmarks.BookmarkTreeNode[] = [];
  const stack = [...tree];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.children?.length) {
      folders.push(n);
      stack.push(...n.children);
    }
  }

  const results: FolderVec[] = [];
  for (const f of folders) {
    const titles = (f.children ?? []).filter(c => c.url).map(c => c.title).slice(0, 200);
    if (!titles.length) continue;
    const embs = await embed(titles, 'passage');
    // 平均
    const dim = embs[0].length;
    const mean = new Array(dim).fill(0);
    for (const v of embs) for (let i = 0; i < dim; i++) mean[i] += v[i];
    for (let i = 0; i < dim; i++) mean[i] /= embs.length;
    results.push({ folderId: f.id, name: f.title, vec: l2norm(mean), size: titles.length });
  }
  await saveCentroids(MODEL, results);
  return results;
}

async function loadCentroids(): Promise<FolderVec[]> {
  const cached = await loadCentroidsFromStorage(MODEL);
  return (cached as FolderVec[]) ?? buildFolderCentroids();
}

// ------------- 提案（上位Kフォルダ） -------------
export async function suggestFoldersForPage(input: { title: string; description?: string; headings?: string[] }, k = 5) {
  const text = [input.title, input.description ?? '', ...(input.headings ?? []).slice(0, 10)]
    .filter(Boolean).join('\n');
  const [q] = await embed([text], 'query');
  const centroids = await loadCentroids();
  const scored = centroids.map(c => ({ ...c, score: cosine(q, c.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored;
}

// メッセージハンドラ（content script から呼ぶ）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.action === 'SUGGEST_FOLDERS') {
      // TODO buildは毎回やらないようにする
      // await buildFolderCentroids();
      const result = await suggestFoldersForPage(msg.payload);
      sendResponse({ ok: true, result });
    } else if (msg.action === 'REBUILD_CENTROIDS') {
      await buildFolderCentroids();
      sendResponse({ ok: true });
    }
  })();
  return true; // async
});
