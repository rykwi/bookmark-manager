// background.ts (MV3 SW)
import { pipeline, env, Tensor } from "@huggingface/transformers";
import {
  saveCentroids,
  loadCentroids as loadCentroidsFromStorage,
} from "./storage";

// 1) モデル選択（まずは軽量＆多言語安定の MiniLM、E5に差し替えも可）
// const MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const MODEL = "Xenova/multilingual-e5-small";

// 例: const MODEL = 'Xenova/multilingual-e5-small';

// 2) WebGPU がダメでも WASM に自動フォールバック
const DEVICE: "webgpu" | "wasm" = "wasm";

// 3) ローカル同梱に切り替える場合
// env.allowLocalModels = true;
// env.localModelPath = chrome.runtime.getURL('models/');

let extractorPromise: ReturnType<typeof pipeline> | null = null;
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL, {
      device: DEVICE,
      dtype: "int8", // 量子化モデルを指定
    });
  }
  return extractorPromise;
}

/**
 * L2正規化
 * @param x
 * @returns
 */
function l2norm(x: number[]) {
  const s = Math.sqrt(x.reduce((a, b) => a + b * b, 0)) || 1;
  return x.map((v) => v / s);
}
/**
 * 内積をとるだけ　事前にL2正規化してあれば内積を取る＝コサイン類似度らしい
 * @param a
 * @param b
 * @returns
 */
function cosine(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vectors must be of the same length a:${a.length}, b:${b.length}`
    );
  }

  // 内積
  let dot = 0;
  // ベクトルの長さ（ノルム）
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  // ゼロ除算を避ける
  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// E5 を使うなら prefix をここで付ける（非対称: query vs passage）
const withPrefix = (text: string, kind: "query" | "passage") =>
  MODEL.includes("multilingual-e5") ? `${kind}: ${text}` : text;

async function embed(texts: string[], kind: "query" | "passage" = "passage") {
  const extractor = await getExtractor();
  // mean pooling + L2 正規化（Transformers.js v3 はオプション指定が可能）
  // const output = (await extractor(
  //   texts.map((t) => withPrefix(t, kind)),
  //   {
  //     pooling: "mean",
  //     normalize: true,
  //     max_length: 64,
  //     truncation: true,
  //   }
  // )) as Tensor | Tensor[];

  // 修正前のAI↑ ---- 修正後↓ extractorにString[]を渡すとモデルの出力する次元数*配列の長さのベクトルになってしまっていた

  const outputPromise = texts.map(async (text) => {
    const prefixedText = withPrefix(text, kind);
    return await extractor(prefixedText, {
      pooling: "mean",
      normalize: true,
      max_length: 64,
      truncation: true,
    });
  });
  const output = (await Promise.all(outputPromise)) as Tensor | Tensor[];
  const arr = Array.isArray(output) ? output : [output];
  return arr.map((t) => Array.from(t.data as Float32Array));
}

// ------------- フォルダのベクトル（タイトル群の平均） -------------
export type FolderVec = {
  folderId: string;
  name: string;
  vec: number[];
  size: number;
};

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
    const titles = (f.children ?? [])
      .filter((c) => c.url)
      .map((c) => c.title)
      .slice(0, 3); // 各フォルダ3ページまで
    if (!titles.length) continue;

    const t0 = performance.now();
    const embs = await embed(titles, "passage");
    const t1 = performance.now();
    console.log(
      `embed time: ${t1 - t0}ms for ${titles}, 
      titles length: ${titles.length},
      embs length: ${embs.length}`
    );
    console.log();

    // 平均
    const dim = embs[0].length;
    const mean = new Array(dim).fill(0);
    console.log(`mean len: ${mean.length}`);
    for (const v of embs) for (let i = 0; i < dim; i++) mean[i] += v[i];
    for (let i = 0; i < dim; i++) mean[i] /= embs.length;
    results.push({
      folderId: f.id,
      name: f.title,
      // vec: l2norm(mean),
      vec: mean,
      size: titles.length,
    });
  }
  await saveCentroids(MODEL, results);
  return results;
}

async function loadCentroids(): Promise<FolderVec[]> {
  const cached = await loadCentroidsFromStorage(MODEL);
  return (cached as FolderVec[]) ?? buildFolderCentroids();
}

// ------------- 提案（上位Kフォルダ） -------------
export async function suggestFoldersForPage(
  // input: { title: string; content?: string; headings?: string[] },
  pageText: string,
  k = 5
) {
  // const text = [
  //   input.title,
  //   input.content ?? "",
  //   ...(input.headings ?? []).slice(0, 10),
  // ]
  //   .filter(Boolean)
  //   .join("\n");
  console.log(`embedding pageText: ${pageText}`);
  const [q] = await embed([pageText], "query");
  const centroids = await loadCentroids();
  const scored = centroids
    .map((c) => ({ ...c, score: cosineSimilarity(q, c.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored;
}

// メッセージハンドラ（content script から呼ぶ）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.action === "SUGGEST_FOLDERS") {
      // ---

      // 現在のタブの情報を取得
      const tabs = (await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      })) as chrome.tabs.Tab[];
      const activeTab = tabs[0];

      if (!activeTab?.id) {
        sendResponse({ error: "アクティブなタブが見つかりません" });
        return;
      }
      // ページ取得
      const pageData = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => ({
          title: document.title,
          body: document.body?.innerText?.slice(0, 1000) || "",
        }),
      });
      const pageText = `${pageData[0].result?.title} ${pageData[0].result?.body}`;
      // ---
      // TODO buildは毎回やらないようにする
      // await buildFolderCentroids();
      const result = await suggestFoldersForPage(pageText);
      sendResponse({ ok: true, result });
    } else if (msg.action === "REBUILD_CENTROIDS") {
      await buildFolderCentroids();
      sendResponse({ ok: true });
    }
  })();
  return true; // async
});
