// tfidfFolderClassifier.ts

import { updateStatus } from './popup';
import { TinySegmenter } from './tinySegmenter';
import { tokenize } from 'wakachigaki';

const segmenter = new TinySegmenter();
// ---- 型定義 ----
type Vector = { [term: string]: number };
interface FolderData {
  id: string;
  title: string;
  tf: Vector;
  tfidf: Vector;
}

// ---- ユーティリティ ----
function tokenizeText(text: string): string[] {
  // return text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  // return segmenter.segment(text)
  return tokenize(text)
}

function termFrequency(tokens: string[]): Vector {
  const tf: Vector = {};
  const len = tokens.length;
  tokens.forEach(t => tf[t] = (tf[t] || 0) + 1);
  Object.keys(tf).forEach(t => tf[t] /= len);
  return tf;
}

function computeIDF(allTFs: Vector[]): Vector {
  const df: Vector = {};
  const N = allTFs.length;
  allTFs.forEach(tf => {
    Object.keys(tf).forEach(term => df[term] = (df[term] || 0) + 1);
  });
  const idf: Vector = {};
  Object.keys(df).forEach(term => {
    idf[term] = Math.log((N + 1) / (1 + df[term])) + 1;
  });
  return idf;
}

function computeTFIDF(tf: Vector, idf: Vector): Vector {
  const tfidf: Vector = {};
  Object.keys(idf).forEach(term => {
    tfidf[term] = (tf[term] || 0) * idf[term];
  });
  return tfidf;
}

function cosineSimilarity(vecA: Vector, vecB: Vector): number {
  let dot = 0, normA = 0, normB = 0;
  const terms = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
  terms.forEach(term => {
    const a = vecA[term] || 0;
    const b = vecB[term] || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  });
  return (normA && normB) ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

// フォルダを再帰的に処理する関数
function processBookmarkFolders(node: chrome.bookmarks.BookmarkTreeNode, allTFs: Vector[]): FolderData[] {
  const folders: FolderData[] = [];
  
  // 現在のノードがフォルダで、子要素を持つ場合
  if (node.children) {
    // 現在のフォルダの情報を収集
    const titles = node.children.map(c => c.title).join("");
    const tokens = tokenizeText(titles);
    console.log(`フォルダ「${node.title}」のトークン:`, tokens);
    const tf = termFrequency(tokens);
    allTFs.push(tf);
    folders.push({ id: node.id, title: node.title, tf, tfidf: {} });

    // 子フォルダを再帰的に処理
    node.children.forEach(child => {
      if (child.children) {
        folders.push(...processBookmarkFolders(child, allTFs));
      }
    });
  }
  
  return folders;
}

// ---- メインロジック ----
async function main(request: any, sender: any, sendResponse: any) {
  if (request.action !== 'BOOKMARK_MANAGER') return;

  console.log(`メッセージを受信: ${request.action}`);
  
  // 現在のタブの情報を取得
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }) as chrome.tabs.Tab[];
  const activeTab = tabs[0];
  
  if (!activeTab?.id) {
    sendResponse({ error: 'アクティブなタブが見つかりません' });
    return;
  }

  // ページ取得
  const pageData = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: () => ({
      title: document.title,
      body: document.body?.innerText?.slice(0, 1000) || ""
    })
  });
  const pageText = `${pageData[0].result?.title} ${pageData[0].result?.body}`;
  const pageTokens = tokenizeText(pageText);
  console.log(`ページのトークン:`, pageTokens);
  const pageTF = termFrequency(pageTokens);

  // ストレージからIDFベクトル取得
  const stored = await chrome.storage.local.get(["idf", "folders"]);
  let idf: Vector = stored.idf;
  let folders: FolderData[] = stored.folders || [];

  // IDFベクトルがなければ初期化
  if (/*!idf || Object.keys(idf).length === 0*/true) { // クリックのたびにIDFベクトルを再計算させている
    const tree = await chrome.bookmarks.getTree() as chrome.bookmarks.BookmarkTreeNode[];
    const allTFs: Vector[] = [];

    // ブックマークツリーのルートから再帰的に処理
    folders = processBookmarkFolders(tree[0], allTFs);

    console.log(`処理したフォルダ数: ${folders.length}`);
    console.log(`フォルダ一覧:`, folders.map(f => f.title));

    idf = computeIDF(allTFs);
    folders.forEach(f => f.tfidf = computeTFIDF(f.tf, idf));
    await chrome.storage.local.set({ idf, folders });
  }

  console.log(`idf vector:`, idf);
  
  // ページのTF-IDFベクトル作成
  const pageTFIDF = computeTFIDF(pageTF, idf);

  // 類似度計算
  const folderScores: { folder: FolderData; score: number }[] = [];
  folders.forEach(folder => {
    const score = cosineSimilarity(pageTFIDF, folder.tfidf);
    folderScores.push({ folder, score });
  });

  // スコアで降順ソートして上位3つを取得
  const topFolders = folderScores
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  console.log(`上位3つのフォルダ:`, topFolders.map(f => ({
    title: f.folder.title,
    score: f.score
  })));
  
  // 結果を送信
  if (topFolders.length > 0) {
    sendResponse({
      folders: topFolders.map(({ folder, score }) => ({
        id: folder.id,
        title: folder.title,
        score: score
      }))
    });
  } else {
    sendResponse({ error: '適切なフォルダが見つかりませんでした' });
  }
}

chrome.runtime.onMessage.addListener( (request, sender, sendResponse) => {
  main(request, sender, sendResponse);
  return true;
});