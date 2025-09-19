// storage.ts
import { createStore, get, set, del } from 'idb-keyval';

const store = createStore('bookmark-classifier-db', 'kv');

// 既存の chrome.storage.local -> IDB へ一度だけ移行（任意）
export async function migrateCentroidsIfNeeded(model: string) {
  const key = `centroids:${model}`;
  try {
    const { [key]: existing } = await chrome.storage.local.get([key]);
    if (existing !== undefined) {
      await set(key, existing, store);
      await chrome.storage.local.remove([key]); // 片付け
    }
  } catch {
    // 失敗しても致命ではないので黙殺
  }
}

export async function saveCentroids(model: string, results: unknown) {
  const key = `centroids:${model}`;
  await set(key, results, store);
}

export async function loadCentroids<T = unknown>(model: string): Promise<T | undefined> {
  const key = `centroids:${model}`;
  return get<T>(key, store);
}

export async function deleteCentroids(model: string) {
  const key = `centroids:${model}`;
  await del(key, store);
}
