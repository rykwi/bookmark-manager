// フォルダ情報のインターフェース
export interface Folder {
  id: string;
  title: string;
  score: number;
}

// タブ情報のインターフェース
export interface Tab {
  id?: number;
  url?: string;
  title?: string;
}

// レスポンスのインターフェース
export interface AnalysisResponse {
  folders?: Folder[];
  error?: string;
}

// DOMの読み込みが完了したら実行
document.addEventListener('DOMContentLoaded', async (): Promise<void> => {
  // 現在のタブの情報を取得
  const tabs: Tab[] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0) {
    showError('アクティブなタブが見つかりません');
    return;
  }

  const currentTab: Tab = tabs[0];
  
  // ステータス表示を更新
  updateStatus('ページを分析中!');
  
  try {
    // バックグラウンドスクリプトにメッセージを送信してページを分析
    const response: AnalysisResponse = await chrome.runtime.sendMessage({
      action: 'BOOKMARK_MANAGER',
      // url: currentTab.url,
      // title: currentTab.title
    });
    
    console.log('バックグラウンドスクリプトからの応答:', response);
    
    // レスポンスの存在チェックを追加
    if (!response) {
      showError('バックグラウンドスクリプトからの応答がありません');
      return;
    }
    
    // レスポンスを処理
    if (response.error) {
      showError(response.error);
      return;
    }
    if (response.folders && response.folders.length > 0) {
      // 推奨フォルダを表示
      displayRecommendedFolders(response.folders, currentTab);
    } else {
      // 推奨フォルダが見つからない場合
      updateStatus('適切なフォルダが見つかりませんでした');
    }
  } catch (error) {
    console.error('エラーが発生しました:', error);
    showError('ページの分析中にエラーが発生しました');
  }
});

// ステータス表示を更新する関数
export function updateStatus(message: string): void {
  const statusElement: HTMLElement | null = document.getElementById('status');
  if (statusElement) {
    statusElement.textContent = message;
  }
}

// エラーを表示する関数
function showError(message: string): void {
  updateStatus(`エラー: ${message}`);
}

// 推奨フォルダを表示する関数
function displayRecommendedFolders(folders: Folder[], currentTab: Tab): void {
  const folderListElement: HTMLElement | null = document.getElementById('folderList');
  if (!folderListElement) return;
  
  // フォルダリストをクリア
  folderListElement.innerHTML = '';
  
  // ステータスを更新
  updateStatus('推奨フォルダ:');
  
  // 各フォルダのアイテムを作成
  folders.forEach((folder: Folder) => {
    const folderItem: HTMLDivElement = document.createElement('div');
    folderItem.className = 'folder-item';
    folderItem.dataset.folderId = folder.id;
    
    // フォルダ名と類似度スコアを表示
    const similarityPercentage: number = Math.round(folder.score * 100);
    folderItem.innerHTML = `
      <span class="folder-name">${folder.title}</span>
      <span class="similarity-score">${similarityPercentage}%</span>
    `;
    
    // クリックイベントを追加
    folderItem.addEventListener('click', async (): Promise<void> => {
      try {
        // ブックマークを作成
        await chrome.bookmarks.create({
          parentId: folder.id,
          title: currentTab.title,
          url: currentTab.url
        });
        
        // 成功メッセージを表示
        updateStatus(`「${folder.title}」にブックマークしました`);
        
        // フォルダリストをクリア
        folderListElement.innerHTML = '';
        
        // 3秒後にポップアップを閉じる
        setTimeout((): void => {
          window.close();
        }, 3000);
      } catch (error) {
        console.error('ブックマーク作成中にエラーが発生しました:', error);
        showError('ブックマークの作成中にエラーが発生しました');
      }
    });
    
    // フォルダリストに追加
    folderListElement.appendChild(folderItem);
  });
} 