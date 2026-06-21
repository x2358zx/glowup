// ==========================================================================
// GlowUp PWA 離線健身應用 - 核心 JavaScript 邏輯
// ==========================================================================

// --- Supabase 正式連線設定 (如果您有自己的專案，可以直接在此填寫，部署時會直接套用) ---
const SUPABASE_CONFIG = {
    url: '',      // 例如: 'https://your-project.supabase.co'
    anonKey: ''   // 例如: 'your-anon-key'
};

// --- 預設測試帳號清單 (點擊上方切換器時會自動套用) ---
const PRESET_ACCOUNTS = {
    'student1': {
        email: 'student1@glowup.com',
        name: '學員 (小明)',
        role: 'student',
        groupId: 'demo-group-123'
    },
    'student2': {
        email: 'student2@glowup.com',
        name: '學員 (小美)',
        role: 'student',
        groupId: 'demo-group-123'
    },
    'coach': {
        email: 'coach@glowup.com',
        name: '教練 (阿強)',
        role: 'coach',
        groupId: 'demo-group-123'
    }
};

// --- 全域狀態與設定 ---
let db = null;
let supabaseClient = null;
let currentUnit = localStorage.getItem('glowup_unit') || 'kg'; // 'kg' 或 'lb'

// 預設以小明身分登入
let currentUser = {
    email: localStorage.getItem('glowup_email') || PRESET_ACCOUNTS.student1.email,
    name: localStorage.getItem('glowup_name') || PRESET_ACCOUNTS.student1.name,
    role: localStorage.getItem('glowup_role') || PRESET_ACCOUNTS.student1.role,
    groupId: localStorage.getItem('glowup_group_id') || PRESET_ACCOUNTS.student1.groupId
};
let selectedDate = new Date().toISOString().split('T')[0];
let activeLogs = [];
let masterWorkouts = [];
let chartInstance = null; // 儲存 1RM Chart.js 實例

// --- 預設動作媒體資料庫 (Demo 影音檔案) ---
const EXERCISE_MEDIA_DATABASE = {
    'EX_SQUAT_01': {
        name: '後背蹲舉 (Back Squat)',
        mediaUrl: 'https://vjs.zencdn.net/v/oceans.mp4' // 示範公用影片
    },
    'EX_BENCH_01': {
        name: '槓鈴臥推 (Bench Press)',
        mediaUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4'
    },
    'EX_DEAD_01': {
        name: '硬舉 (Deadlift)',
        mediaUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4'
    },
    'EX_PULLUP_01': {
        name: '引體向上 (Pull-Up)',
        mediaUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4'
    },
    'EX_SHOULDER_01': {
        name: '啞鈴肩推 (Dumbbell Shoulder Press)',
        mediaUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4'
    }
};

// ==========================================
// 1. 初始化 IndexedDB
// ==========================================
function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('GlowUpDB', 1);

        request.onupgradeneeded = function(e) {
            const database = e.target.result;
            
            // 建立主課表 Cache
            if (!database.objectStoreNames.contains('master_workouts')) {
                database.createObjectStore('master_workouts', { keyPath: 'id' });
            }
            // 建立學生今日訓練紀錄 Store
            if (!database.objectStoreNames.contains('student_active_logs')) {
                const logStore = database.createObjectStore('student_active_logs', { keyPath: 'id' });
                // 用於離線同步過濾的索引
                logStore.createIndex('synced', 'synced', { unique: false });
                logStore.createIndex('student_email_date', ['student_email', 'date'], { unique: false });
            }
            // 建立群組快取
            if (!database.objectStoreNames.contains('groups')) {
                database.createObjectStore('groups', { keyPath: 'id' });
            }
            // 建立個人設定快取
            if (!database.objectStoreNames.contains('profiles')) {
                database.createObjectStore('profiles', { keyPath: 'id' });
            }
        };

        request.onsuccess = function(e) {
            db = e.target.result;
            console.log('[IndexedDB] 資料庫連接成功');
            resolve(db);
        };

        request.onerror = function(e) {
            console.error('[IndexedDB] 連接錯誤:', e.target.error);
            reject(e.target.error);
        };
    });
}

// ==========================================
// 2. 初始化 Supabase Client
// ==========================================
function initSupabase() {
    let supabaseUrl = SUPABASE_CONFIG.url || localStorage.getItem('glowup_supabase_url');
    let supabaseKey = SUPABASE_CONFIG.anonKey || localStorage.getItem('glowup_supabase_key');

    if (supabaseUrl && supabaseKey) {
        try {
            // 從全域 window 中獲取由 CDN 引入的 supabase
            if (window.supabase) {
                supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);
                console.log('[Supabase] 已成功建立連線實例');
            }
        } catch (e) {
            console.error('[Supabase] 初始化失敗:', e);
        }
    } else {
        console.log('[Supabase] 未設定 API 連線金鑰，將運行於「離線模擬模式」');
    }
}

// ==========================================
// 3. 離線資料讀寫模組 (IndexedDB CRUD)
// ==========================================

function getMasterWorkoutsFromIndexedDB(date, groupId) {
    return new Promise((resolve) => {
        const transaction = db.transaction(['master_workouts'], 'readonly');
        const store = transaction.objectStore('master_workouts');
        const request = store.getAll();
        
        request.onsuccess = function() {
            const all = request.result;
            // 篩選對應日期和群組的課表
            const filtered = all.filter(item => item.date === date && item.group_id === groupId);
            resolve(filtered);
        };
        request.onerror = () => resolve([]);
    });
}

function getActiveLogsFromIndexedDB(date, email) {
    return new Promise((resolve) => {
        const transaction = db.transaction(['student_active_logs'], 'readonly');
        const store = transaction.objectStore('student_active_logs');
        
        // 優先嘗試使用複合索引
        try {
            const index = store.index('student_email_date');
            const request = index.getAll(IDBKeyRange.only([email, date]));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => fallbackScan();
        } catch (err) {
            fallbackScan();
        }

        // 備用全表掃描
        function fallbackScan() {
            const request = store.getAll();
            request.onsuccess = function() {
                const all = request.result;
                const filtered = all.filter(item => item.date === date && item.student_email === email);
                resolve(filtered);
            };
            request.onerror = () => resolve([]);
        }
    });
}

function saveActiveLogToIndexedDB(log) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['student_active_logs'], 'readwrite');
        const store = transaction.objectStore('student_active_logs');
        const request = store.put(log);
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

function getUnsyncedLogsFromIndexedDB() {
    return new Promise((resolve) => {
        const transaction = db.transaction(['student_active_logs'], 'readonly');
        const store = transaction.objectStore('student_active_logs');
        const index = store.index('synced');
        const request = index.getAll(IDBKeyRange.only(false)); // 尋找 synced = false
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve([]);
    });
}

function deleteActiveLogFromIndexedDB(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['student_active_logs'], 'readwrite');
        const store = transaction.objectStore('student_active_logs');
        const request = store.delete(id);
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

function saveMasterWorkoutsToIndexedDB(workouts) {
    return new Promise((resolve) => {
        const transaction = db.transaction(['master_workouts'], 'readwrite');
        const store = transaction.objectStore('master_workouts');
        workouts.forEach(w => store.put(w));
        transaction.oncomplete = () => resolve();
    });
}

// ==========================================
// 4. 網路狀態監聽與自動批次同步引擎 (Sync Engine)
// ==========================================

async function syncOfflineData() {
    if (!navigator.onLine) {
        showSyncToast('📴 目前處於離線狀態，無法同步。');
        return;
    }
    if (!supabaseClient) {
        console.log('[Sync] 未設定 Supabase，跳過同步。');
        return;
    }

    try {
        const unsyncedLogs = await getUnsyncedLogsFromIndexedDB();
        if (unsyncedLogs.length === 0) {
            console.log('[Sync] 無本地未同步資料');
            return;
        }

        showSyncToast(`🔄 偵測到網路，正自動同步 ${unsyncedLogs.length} 筆紀錄...`);

        // 將本地暫存的 UUID 紀錄寫入 Supabase (使用 Upsert)
        for (const log of unsyncedLogs) {
            // 複製一份，把本地輔助標記 synced 拿掉再送上雲端
            const { synced, ...dbLog } = log;
            
            const { error } = await supabaseClient
                .from('student_active_logs')
                .upsert(dbLog);

            if (error) {
                console.error(`[Sync] 同步單筆記錄失敗 (ID: ${log.id}):`, error);
                throw error;
            }

            // 同步成功，更新本地狀態為已同步
            log.synced = true;
            await saveActiveLogToIndexedDB(log);
        }

        showSyncToast('✅ 離線資料已成功批次同步至 Supabase！');
        
        // 重新載入目前畫面
        loadWorkouts();
        renderCalendar();
    } catch (e) {
        console.error('[Sync] 批次同步過程中出錯:', e);
        showSyncToast('❌ 同步失敗，將於下一次連線時重試。');
    }
}

// 監聽連線事件
window.addEventListener('online', syncOfflineData);
window.addEventListener('offline', () => {
    showSyncToast('📴 已進入離線狀態，健身數據將安全儲存在本地！');
    updateOnlineStatusUI();
});

function showSyncToast(message) {
    const toast = document.getElementById('sync-toast');
    toast.textContent = message;
    toast.classList.add('active');
    setTimeout(() => {
        toast.classList.remove('active');
    }, 4000);
}

function updateOnlineStatusUI() {
    const badge = document.getElementById('network-status');
    if (navigator.onLine) {
        badge.className = 'badge-status online';
        badge.innerHTML = '<span class="status-dot"></span>連線中';
    } else {
        badge.className = 'badge-status offline';
        badge.innerHTML = '<span class="status-dot"></span>離線 (地下室模式)';
    }
}

// ==========================================
// 5. 智慧型媒體預快取與去重機制 (Cache API)
// ==========================================

async function preloadExerciseMedia(exerciseId, url) {
    if (!url) return;
    
    const cacheName = 'glowup-media-v1';
    const cacheKey = `/exercise-media/${exerciseId}`;

    try {
        const cache = await caches.open(cacheName);
        const cachedResponse = await cache.match(cacheKey);

        if (cachedResponse) {
            console.log(`[Smart Preload] 命中快取! 動作 ${exerciseId} 影片已存在，跳過重複下載。`);
            return;
        }

        if (!navigator.onLine) {
            console.log(`[Smart Preload] 離線狀態下無法預載動作 ${exerciseId}`);
            return;
        }

        console.log(`[Smart Preload] 開始下載並快取動作 ${exerciseId} 影音資源...`);
        // 使用 cors 模式下載
        const response = await fetch(url, { mode: 'cors' });
        if (response.status === 200) {
            await cache.put(cacheKey, response);
            console.log(`[Smart Preload] 動作 ${exerciseId} 快取成功！`);
            
            // 重新整理 UI 的快取狀態
            updateMediaCacheBadgeUI(exerciseId, true);
        }
    } catch (e) {
        console.warn(`[Smart Preload] 無法預載動作媒體 (ID: ${exerciseId}):`, e);
    }
}

// 檢查單個動作是否已快取
async function checkIsMediaCached(exerciseId) {
    const cacheName = 'glowup-media-v1';
    const cacheKey = `/exercise-media/${exerciseId}`;
    try {
        const cache = await caches.open(cacheName);
        const cachedResponse = await cache.match(cacheKey);
        return !!cachedResponse;
    } catch (e) {
        return false;
    }
}

function updateMediaCacheBadgeUI(exerciseId, isCached) {
    const badge = document.querySelector(`.media-badge-${exerciseId}`);
    if (badge) {
        if (isCached) {
            badge.className = `media-cache-badge cached media-badge-${exerciseId}`;
            badge.innerHTML = '✓ 離線已存檔';
        } else {
            badge.className = `media-cache-badge uncached media-badge-${exerciseId}`;
            badge.innerHTML = '⚠ 需連線下載';
        }
    }
}

// ==========================================
// 6. 今日訓練載入、Claim 領取與增刪查改
// ==========================================

async function loadWorkouts() {
    updateOnlineStatusUI();
    const dateStr = selectedDate;
    const email = currentUser.email;
    const groupId = currentUser.groupId;

    // A. 嘗試從本地 IndexedDB 讀取已被領取的訓練紀錄
    activeLogs = await getActiveLogsFromIndexedDB(dateStr, email);

    // B. 如果有設定 Supabase 且在線，則從雲端獲取最新紀錄更新本地
    if (navigator.onLine && supabaseClient) {
        try {
            // 1. 抓取雲端已領取的 Active Logs
            const { data: remoteLogs, error: logErr } = await supabaseClient
                .from('student_active_logs')
                .select('*')
                .eq('date', dateStr)
                .eq('student_email', email);

            if (!logErr && remoteLogs) {
                // 將雲端最新的 upsert 到 IndexedDB
                for (const log of remoteLogs) {
                    log.synced = true;
                    await saveActiveLogToIndexedDB(log);
                }
                // 重新載入本地 Active Logs
                activeLogs = await getActiveLogsFromIndexedDB(dateStr, email);
            }

            // 2. 抓取教練今日的主課表 (Master Workout)
            const { data: remoteMaster, error: masterErr } = await supabaseClient
                .from('master_workouts')
                .select('*')
                .eq('date', dateStr)
                .eq('group_id', groupId);

            if (!masterErr && remoteMaster) {
                await saveMasterWorkoutsToIndexedDB(remoteMaster);
            }
        } catch (e) {
            console.warn('[Sync] 載入資料時發生連線失敗，自動改用本地快取數據:', e);
        }
    }

    // C. 載入本地主課表快取
    masterWorkouts = await getMasterWorkoutsFromIndexedDB(dateStr, groupId);

    // D. 智慧預載今日所有動作影音檔案 (不重複下載)
    if (navigator.onLine) {
        const allExerciseIds = new Set();
        masterWorkouts.forEach(w => allExerciseIds.add(w.exercise_id));
        activeLogs.forEach(l => {
            allExerciseIds.add(l.exercise_id);
            if (l.swapped_exercise_id) allExerciseIds.add(l.swapped_exercise_id);
        });

        allExerciseIds.forEach(exId => {
            const mediaInfo = EXERCISE_MEDIA_DATABASE[exId];
            if (mediaInfo) {
                preloadExerciseMedia(exId, mediaInfo.mediaUrl);
            }
        });
    }

    // E. 渲染 UI
    renderWorkoutPage();
}

async function claimWorkout() {
    if (masterWorkouts.length === 0) {
        alert('今日教練尚未發布主課表模板！');
        return;
    }

    showSyncToast('🚀 正在領取今日主課表並生成您的專屬訓練...');

    const email = currentUser.email;
    const groupId = currentUser.groupId;
    const dateStr = selectedDate;

    // 將教練發布的每一項動作複製成學生專屬紀錄
    for (const master of masterWorkouts) {
        // 預設建立 target_sets 個組數結構
        const defaultSets = [];
        for (let i = 1; i <= master.target_sets; i++) {
            defaultSets.push({
                set_index: i,
                reps: 10,
                weight_kg: 40,
                completed: false
            });
        }

        const newLog = {
            id: crypto.randomUUID(), // 生成唯一識別碼
            master_workout_id: master.id,
            group_id: groupId,
            student_email: email,
            date: dateStr,
            exercise_id: master.exercise_id,
            exercise_name: master.exercise_name,
            target_sets: master.target_sets,
            sets: defaultSets,
            status: 'pending',
            swapped_exercise_id: null,
            swapped_exercise_name: null,
            updated_at: new Date().toISOString(),
            synced: false // 標記為尚未同步至雲端
        };

        await saveActiveLogToIndexedDB(newLog);
    }

    // 觸發一次同步
    syncOfflineData();
    // 重新加載
    loadWorkouts();
}

async function updateLogSet(logId, setIndex, field, value) {
    const log = activeLogs.find(l => l.id === logId);
    if (!log) return;

    const set = log.sets.find(s => s.set_index === setIndex);
    if (!set) return;

    if (field === 'completed') {
        set.completed = value;
    } else if (field === 'reps') {
        set.reps = parseInt(value) || 0;
    } else if (field === 'weight') {
        // 重點邏輯：如果當前單位是 lb，需要將輸入的 lb 轉換成 kg 存入資料庫
        let valKg = parseFloat(value) || 0;
        if (currentUnit === 'lb') {
            valKg = valKg / 2.20462;
        }
        set.weight_kg = valKg;
    }

    // 檢查是否此動作所有組數均已勾選完成
    const allDone = log.sets.every(s => s.completed);
    log.status = allDone ? 'completed' : 'pending';
    log.updated_at = new Date().toISOString();
    log.synced = false;

    // 儲存至本地
    await saveActiveLogToIndexedDB(log);

    // 觸發同步且不刷新整個頁面 (僅背景同步)
    syncOfflineData();
}

async function addSetToExercise(logId) {
    const log = activeLogs.find(l => l.id === logId);
    if (!log) return;

    const nextIndex = log.sets.length + 1;
    // 複製最後一組的數據作為預設值
    const lastSet = log.sets[log.sets.length - 1] || { reps: 10, weight_kg: 40 };
    
    log.sets.push({
        set_index: nextIndex,
        reps: lastSet.reps,
        weight_kg: lastSet.weight_kg,
        completed: false
    });
    log.status = 'pending';
    log.updated_at = new Date().toISOString();
    log.synced = false;

    await saveActiveLogToIndexedDB(log);
    syncOfflineData();
    loadWorkouts();
}

async function deleteSetFromExercise(logId, setIndex) {
    const log = activeLogs.find(l => l.id === logId);
    if (!log || log.sets.length <= 1) return;

    log.sets = log.sets.filter(s => s.set_index !== setIndex);
    // 重新排序組數 index
    log.sets.forEach((s, idx) => s.set_index = idx + 1);

    log.synced = false;
    log.updated_at = new Date().toISOString();
    await saveActiveLogToIndexedDB(log);
    
    syncOfflineData();
    loadWorkouts();
}

// 替換動作彈窗相關
let swappingLogId = null;
function openSwapModal(logId) {
    swappingLogId = logId;
    const log = activeLogs.find(l => l.id === logId);
    if (!log) return;

    const select = document.getElementById('swap-exercise-select');
    select.innerHTML = '';
    
    // 填充除了當前動作以外的動作清單
    Object.entries(EXERCISE_MEDIA_DATABASE).forEach(([exId, details]) => {
        if (exId !== log.exercise_id) {
            const option = document.createElement('option');
            option.value = exId;
            option.textContent = details.name;
            select.appendChild(option);
        }
    });

    document.getElementById('swap-modal').classList.add('active');
}

async function confirmSwapExercise() {
    const newExId = document.getElementById('swap-exercise-select').value;
    const mediaInfo = EXERCISE_MEDIA_DATABASE[newExId];
    if (!mediaInfo || !swappingLogId) return;

    const log = activeLogs.find(l => l.id === swappingLogId);
    if (!log) return;

    log.swapped_exercise_id = newExId;
    log.swapped_exercise_name = mediaInfo.name;
    log.updated_at = new Date().toISOString();
    log.synced = false;

    await saveActiveLogToIndexedDB(log);
    document.getElementById('swap-modal').classList.remove('active');
    
    // 預載新動作影片
    if (navigator.onLine) {
        preloadExerciseMedia(newExId, mediaInfo.mediaUrl);
    }

    syncOfflineData();
    loadWorkouts();
}

// --- 觸覺回饋 ---
function triggerHapticFeedback() {
    if (navigator.vibrate) {
        navigator.vibrate(12); // 微震動 12 毫秒
    }
}

// --- 快速帳號切換 ---
async function switchAccount(accountId) {
    const account = PRESET_ACCOUNTS[accountId];
    if (!account) return;

    currentUser = { ...account };
    localStorage.setItem('glowup_email', currentUser.email);
    localStorage.setItem('glowup_name', currentUser.name);
    localStorage.setItem('glowup_role', currentUser.role);
    localStorage.setItem('glowup_group_id', currentUser.groupId);

    // 更新設定頁面的 UI 顯示
    renderSettingsPage();
    
    // 如果是教練，加載教練控制台
    loadCoachConsole();

    // 更新全域帳號切換選單
    const switcher = document.getElementById('global-account-switcher');
    if (switcher) switcher.value = accountId;
    
    showSyncToast(`👤 已切換身份為：${currentUser.name}`);
    triggerHapticFeedback();
    
    // 重新載入課表與行行事曆
    await loadWorkouts();
    if (document.getElementById('calendar-page').classList.contains('active')) {
        renderCalendar();
        loadHistoryLogs();
    }
}

// --- 刪除整個訓練動作卡片 ---
async function deleteActiveLog(logId) {
    if (!confirm('您確定要刪除這項動作的所有訓練紀錄嗎？')) return;
    
    triggerHapticFeedback();

    // 1. 從 IndexedDB 刪除
    await deleteActiveLogFromIndexedDB(logId);
    
    // 2. 如果在線且設定了 Supabase，從雲端刪除
    if (navigator.onLine && supabaseClient) {
        try {
            await supabaseClient
                .from('student_active_logs')
                .delete()
                .eq('id', logId);
        } catch (e) {
            console.warn('[Sync] 雲端刪除記錄失敗，連線後將重試');
        }
    }
    
    showSyncToast('🗑 已刪除該訓練動作！');
    loadWorkouts();
}

// --- 自訂動作新增彈窗與功能 ---
function openAddCustomExerciseModal() {
    const select = document.getElementById('custom-exercise-select');
    select.innerHTML = '';
    
    // 填充所有的動作
    Object.entries(EXERCISE_MEDIA_DATABASE).forEach(([exId, details]) => {
        const option = document.createElement('option');
        option.value = exId;
        option.textContent = details.name;
        select.appendChild(option);
    });

    document.getElementById('custom-exercise-modal').classList.add('active');
}

async function confirmAddCustomExercise() {
    const exId = document.getElementById('custom-exercise-select').value;
    if (!exId) return;

    await addCustomExercise(exId);
    document.getElementById('custom-exercise-modal').classList.remove('active');
}

async function addCustomExercise(exerciseId) {
    const mediaInfo = EXERCISE_MEDIA_DATABASE[exerciseId];
    if (!mediaInfo) return;

    triggerHapticFeedback();

    const email = currentUser.email;
    const groupId = currentUser.groupId;
    const dateStr = selectedDate;

    // 建立 3 組預設資料
    const defaultSets = [
        { set_index: 1, reps: 10, weight_kg: 40, completed: false },
        { set_index: 2, reps: 10, weight_kg: 40, completed: false },
        { set_index: 3, reps: 10, weight_kg: 40, completed: false }
    ];

    const newLog = {
        id: crypto.randomUUID(),
        master_workout_id: null,
        group_id: groupId,
        student_email: email,
        date: dateStr,
        exercise_id: exerciseId,
        exercise_name: mediaInfo.name,
        target_sets: 3,
        sets: defaultSets,
        status: 'pending',
        swapped_exercise_id: null,
        swapped_exercise_name: null,
        updated_at: new Date().toISOString(),
        synced: false
    };

    await saveActiveLogToIndexedDB(newLog);
    
    // 預載影片
    if (navigator.onLine) {
        preloadExerciseMedia(exerciseId, mediaInfo.mediaUrl);
    }

    syncOfflineData();
    loadWorkouts();
    showSyncToast(`＋ 已新增自訂動作：${mediaInfo.name}`);
}

// ==========================================
// 7. 公斤 (KG) / 磅 (LB) 前端動態換算
// ==========================================

function toggleUnit() {
    currentUnit = currentUnit === 'kg' ? 'lb' : 'kg';
    localStorage.setItem('glowup_unit', currentUnit);
    document.getElementById('toggle-unit-indicator').textContent = currentUnit.toUpperCase();
    loadWorkouts(); // 重新渲染列表以更新數值顯示
}

function formatWeightDisplay(weightKg) {
    if (currentUnit === 'lb') {
        const lbVal = weightKg * 2.20462;
        return Math.round(lbVal * 10) / 10; // 保留一位小數
    }
    return Math.round(weightKg * 10) / 10;
}

// ==========================================
// 8. 1RM 歷史紀錄與 Chart.js 圖表渲染
// ==========================================

function calculate1RM(weightKg, reps) {
    if (reps === 1) return weightKg;
    // 使用 Epley 公式：1RM = w * (1 + r / 30)
    return weightKg * (1 + reps / 30);
}

async function openOneRepMaxChart(exerciseId) {
    const email = currentUser.email;
    const historyLogs = [];

    // 1. 從 IndexedDB 撈取該用戶此動作的所有歷史紀錄
    const transaction = db.transaction(['student_active_logs'], 'readonly');
    const store = transaction.objectStore('student_active_logs');
    const request = store.getAll();

    request.onsuccess = function() {
        const all = request.result;
        
        // 篩選該學生的紀錄且動作吻合 (或被替換成該動作)
        const relevant = all.filter(l => 
            l.student_email === email && 
            ((!l.swapped_exercise_id && l.exercise_id === exerciseId) || (l.swapped_exercise_id === exerciseId))
        );

        // 依日期排序
        relevant.sort((a, b) => new Date(a.date) - new Date(b.date));

        const chartData = relevant.map(log => {
            // 計算當天所有完成的組數中最高的 1RM
            const completedSets = log.sets.filter(s => s.completed);
            if (completedSets.length === 0) return null;

            const max1RM = Math.max(...completedSets.map(s => calculate1RM(s.weight_kg, s.reps)));
            
            return {
                date: log.date,
                val: formatWeightDisplay(max1RM)
            };
        }).filter(item => item !== null);

        render1RMChart(exerciseId, chartData);
    };
}

function render1RMChart(exerciseId, dataPoints) {
    const modal = document.getElementById('chart-modal');
    modal.classList.add('active');

    const exName = EXERCISE_MEDIA_DATABASE[exerciseId]?.name || exerciseId;
    document.getElementById('chart-modal-title').textContent = `${exName} - 1RM 估算趨勢`;

    const ctx = document.getElementById('oneRepMaxChart').getContext('2d');
    
    if (chartInstance) {
        chartInstance.destroy();
    }

    if (dataPoints.length === 0) {
        ctx.clearRect(0, 0, 400, 250);
        document.getElementById('chart-fallback-text').style.display = 'block';
        document.getElementById('oneRepMaxChart').style.display = 'none';
        return;
    }

    document.getElementById('chart-fallback-text').style.display = 'none';
    document.getElementById('oneRepMaxChart').style.display = 'block';

    const labels = dataPoints.map(d => d.date);
    const values = dataPoints.map(d => d.val);

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: `預估 1RM (${currentUnit.toUpperCase()})`,
                data: values,
                borderColor: '#6366f1',
                backgroundColor: 'rgba(99, 102, 241, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.3,
                pointBackgroundColor: '#14b8a6',
                pointBorderColor: '#ffffff',
                pointRadius: 5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: '#f8fafc', font: { family: 'Plus Jakarta Sans' } }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#94a3b8' }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#94a3b8' }
                }
            }
        }
    });
}

// ==========================================
// 9. 日曆視圖與歷史數據聚合
// ==========================================

let currentCalYear = new Date().getFullYear();
let currentCalMonth = new Date().getMonth(); // 0-11

function renderCalendar() {
    const monthNames = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
    document.getElementById('calendar-month-year').textContent = `${currentCalYear}年 ${monthNames[currentCalMonth]}`;

    const firstDayIndex = new Date(currentCalYear, currentCalMonth, 1).getDay();
    const lastDay = new Date(currentCalYear, currentCalMonth + 1, 0).getDate();
    const prevLastDay = new Date(currentCalYear, currentCalMonth, 0).getDate();

    const grid = document.getElementById('calendar-days-grid');
    grid.innerHTML = '';

    // 1. 撈取 IndexedDB 所有記錄，以進行顏色標記
    const transaction = db.transaction(['student_active_logs'], 'readonly');
    const store = transaction.objectStore('student_active_logs');
    
    store.getAll().onsuccess = function(event) {
        const allLogs = event.target.result.filter(l => l.student_email === currentUser.email);
        
        // 整理每日狀態
        const dayStatusMap = {}; // 'YYYY-MM-DD': 'completed' | 'pending'
        allLogs.forEach(log => {
            if (!dayStatusMap[log.date]) {
                dayStatusMap[log.date] = [];
            }
            dayStatusMap[log.date].push(log.status);
        });

        const dailySummary = {};
        Object.entries(dayStatusMap).forEach(([date, statuses]) => {
            const allCompleted = statuses.every(s => s === 'completed');
            dailySummary[date] = allCompleted ? 'completed' : 'pending';
        });

        // 2. 渲染上個月多餘的天數
        for (let x = firstDayIndex; x > 0; x--) {
            const dayNum = prevLastDay - x + 1;
            const cell = createDayCell(dayNum, false, dailySummary);
            grid.appendChild(cell);
        }

        // 3. 渲染當月天數
        for (let i = 1; i <= lastDay; i++) {
            const cell = createDayCell(i, true, dailySummary);
            grid.appendChild(cell);
        }
    };
}

function createDayCell(dayNum, isCurrentMonth, dailySummary) {
    const cell = document.createElement('div');
    cell.className = 'calendar-day-cell';
    
    if (isCurrentMonth) {
        cell.classList.add('current-month');
        // 格式化為 YYYY-MM-DD
        const mStr = String(currentCalMonth + 1).padStart(2, '0');
        const dStr = String(dayNum).padStart(2, '0');
        const fullDate = `${currentCalYear}-${mStr}-${dStr}`;

        if (fullDate === selectedDate) {
            cell.classList.add('active-day');
        }

        // 日期數字
        cell.innerHTML = `<span class="calendar-day-number">${dayNum}</span>`;

        // 標記小點
        const status = dailySummary[fullDate];
        if (status) {
            const dot = document.createElement('div');
            dot.className = `calendar-dot-indicator ${status}`;
            cell.appendChild(dot);
        }

        cell.addEventListener('click', () => {
            selectedDate = fullDate;
            document.getElementById('workout-date-picker').value = selectedDate;
            
            // 亮起選中狀態
            document.querySelectorAll('.calendar-day-cell').forEach(c => c.classList.remove('active-day'));
            cell.classList.add('active-day');
            
            // 切換回 Workout 主頁並加載
            switchTab('workout');
            loadWorkouts();
        });
    } else {
        cell.classList.add('other-month');
        cell.innerHTML = `<span class="calendar-day-number">${dayNum}</span>`;
    }
    
    return cell;
}

function changeMonth(direction) {
    currentCalMonth += direction;
    if (currentCalMonth < 0) {
        currentCalMonth = 11;
        currentCalYear--;
    } else if (currentCalMonth > 11) {
        currentCalMonth = 0;
        currentCalYear++;
    }
    renderCalendar();
}

// 載入歷史日誌概要清單 (聚合單日 summary 顯示)
function loadHistoryLogs() {
    const historyList = document.getElementById('history-summary-list');
    historyList.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-muted);">正在載入訓練歷史...</div>';

    const transaction = db.transaction(['student_active_logs'], 'readonly');
    const store = transaction.objectStore('student_active_logs');
    
    store.getAll().onsuccess = function(e) {
        const logs = e.target.result.filter(l => l.student_email === currentUser.email);
        
        if (logs.length === 0) {
            historyList.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-muted);">尚無任何訓練紀錄</div>';
            return;
        }

        // 依日期分組
        const grouped = {};
        logs.forEach(log => {
            if (!grouped[log.date]) grouped[log.date] = [];
            grouped[log.date].push(log);
        });

        // 依日期倒序
        const sortedDates = Object.keys(grouped).sort((a, b) => new Date(b) - new Date(a));
        historyList.innerHTML = '';

        sortedDates.forEach(date => {
            const dayLogs = grouped[date];
            const completedCount = dayLogs.filter(l => l.status === 'completed').length;
            
            const item = document.createElement('div');
            item.className = 'history-item';
            
            // 聚合訓練內容文字，例如 "後背蹲舉, 槓鈴臥推"
            const exerciseNames = dayLogs.map(l => l.swapped_exercise_name || l.exercise_name).join(', ');
            
            item.innerHTML = `
                <div class="history-info">
                    <div class="history-date">${date}</div>
                    <div style="font-size:0.8rem; color:var(--text-secondary);">${exerciseNames}</div>
                </div>
                <div class="history-summary">
                    ✅ 已完成: ${completedCount}/${dayLogs.length} 動作
                </div>
            `;
            
            item.addEventListener('click', () => {
                selectedDate = date;
                document.getElementById('workout-date-picker').value = selectedDate;
                switchTab('workout');
                loadWorkouts();
            });

            historyList.appendChild(item);
        });
    };
}

// ==========================================
// 10. 教練主課表 console 功能 (Coach View)
// ==========================================

async function loadCoachConsole() {
    if (currentUser.role !== 'coach') {
        document.getElementById('coach-section').style.display = 'none';
        return;
    }
    document.getElementById('coach-section').style.display = 'block';
    
    // 渲染目前日期的課表模板
    const list = document.getElementById('coach-master-list');
    list.innerHTML = '';

    const dateStr = selectedDate;
    const groupMaster = masterWorkouts.filter(w => w.date === dateStr);

    if (groupMaster.length === 0) {
        list.innerHTML = '<div style="text-align:center; color:var(--text-muted); font-size:0.9rem;">今日尚未新增主課表範本</div>';
        return;
    }

    groupMaster.forEach(workout => {
        const item = document.createElement('div');
        item.style = 'display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.02); padding:0.75rem 1rem; border-radius:0.5rem; margin-bottom:0.5rem; border:1px solid var(--border-color);';
        
        item.innerHTML = `
            <div>
                <div style="font-weight:700;">${workout.exercise_name}</div>
                <div style="font-size:0.75rem; color:var(--text-secondary);">目標: ${workout.target_sets} 組</div>
            </div>
            <button class="btn btn-danger btn-icon" onclick="deleteMasterWorkout('${workout.id}')">
                <i>✕</i>
            </button>
        `;
        list.appendChild(item);
    });
}

async function addMasterWorkout() {
    const exerciseSelect = document.getElementById('coach-exercise-select');
    const setsInput = document.getElementById('coach-sets-input');
    const notesInput = document.getElementById('coach-notes-input');

    const exId = exerciseSelect.value;
    const targetSets = parseInt(setsInput.value) || 3;
    const notes = notesInput.value;
    const exerciseName = EXERCISE_MEDIA_DATABASE[exId].name;

    const newMaster = {
        id: crypto.randomUUID(),
        group_id: currentUser.groupId,
        date: selectedDate,
        exercise_id: exId,
        exercise_name: exerciseName,
        target_sets: targetSets,
        notes: notes,
        created_at: new Date().toISOString()
    };

    // 1. 寫入 IndexedDB
    const transaction = db.transaction(['master_workouts'], 'readwrite');
    transaction.objectStore('master_workouts').put(newMaster);
    
    transaction.oncomplete = async function() {
        console.log('[Coach] 主課表快取已更新');
        
        // 2. 如果在線，寫入 Supabase
        if (navigator.onLine && supabaseClient) {
            try {
                const { error } = await supabaseClient
                    .from('master_workouts')
                    .insert(newMaster);
                if (error) throw error;
                showSyncToast('✅ 教練課表已發布至雲端！');
            } catch (e) {
                console.error('[Coach] 無法發布主課表至雲端:', e);
                showSyncToast('⚠ 雲端發布失敗，已保存在本地，連線後自動重試');
            }
        }

        // 清空輸入
        notesInput.value = '';
        
        // 重新載入
        loadWorkouts();
    };
}

async function deleteMasterWorkout(id) {
    const transaction = db.transaction(['master_workouts'], 'readwrite');
    transaction.objectStore('master_workouts').delete(id);

    transaction.oncomplete = async function() {
        if (navigator.onLine && supabaseClient) {
            try {
                await supabaseClient
                    .from('master_workouts')
                    .delete()
                    .eq('id', id);
            } catch (e) {
                console.warn('[Coach] 雲端刪除主課表失敗');
            }
        }
        loadWorkouts();
    };
}

// ==========================================
// 11. 前端頁面切換與初始化
// ==========================================

function switchTab(tabId) {
    // 切換按鈕亮起
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('onclick').includes(tabId)) {
            btn.classList.add('active');
        }
    });

    // 切換頁面顯示
    document.querySelectorAll('.app-page').forEach(page => {
        page.classList.remove('active');
    });
    
    const activePage = document.getElementById(`${tabId}-page`);
    activePage.classList.add('active');

    // 切換分頁載入特定邏輯
    if (tabId === 'workout') {
        loadWorkouts();
    } else if (tabId === 'calendar') {
        renderCalendar();
        loadHistoryLogs();
    } else if (tabId === 'settings') {
        renderSettingsPage();
    }
}

// 載入預載體驗資料庫 (Mock Data)
async function loadDemoMockData() {
    showSyncToast('💡 正在生成示範體驗資料...');
    
    // A. 寫入模擬的主課表 (Master Workouts) - 今天
    const today = new Date().toISOString().split('T')[0];
    const mockMasters = [
        {
            id: 'mock-m-1',
            group_id: currentUser.groupId,
            date: today,
            exercise_id: 'EX_SQUAT_01',
            exercise_name: '後背蹲舉 (Back Squat)',
            target_sets: 4,
            notes: '地下室訓練重點：動作下蹲到大腿與地面平行，起立時呼氣',
            created_at: new Date().toISOString()
        },
        {
            id: 'mock-m-2',
            group_id: currentUser.groupId,
            date: today,
            exercise_id: 'EX_BENCH_01',
            exercise_name: '槓鈴臥推 (Bench Press)',
            target_sets: 4,
            notes: '控制下放速度，胸大肌充分拉伸',
            created_at: new Date().toISOString()
        }
    ];

    // B. 寫入模擬的主課表 (Master Workouts) - 昨天
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const mockMastersYesterday = [
        {
            id: 'mock-m-3',
            group_id: currentUser.groupId,
            date: yesterday,
            exercise_id: 'EX_DEAD_01',
            exercise_name: '硬舉 (Deadlift)',
            target_sets: 3,
            notes: '背部打直，足底均勻受力',
            created_at: new Date().toISOString()
        }
    ];

    // C. 寫入昨日學生已完成的紀錄
    const mockYesterdayLogs = [
        {
            id: 'mock-l-1',
            master_workout_id: 'mock-m-3',
            group_id: currentUser.groupId,
            student_email: currentUser.email,
            date: yesterday,
            exercise_id: 'EX_DEAD_01',
            exercise_name: '硬舉 (Deadlift)',
            target_sets: 3,
            sets: [
                { set_index: 1, reps: 10, weight_kg: 80, completed: true },
                { set_index: 2, reps: 8, weight_kg: 90, completed: true },
                { set_index: 3, reps: 6, weight_kg: 100, completed: true }
            ],
            status: 'completed',
            swapped_exercise_id: null,
            swapped_exercise_name: null,
            updated_at: new Date().toISOString(),
            synced: true
        }
    ];

    await saveMasterWorkoutsToIndexedDB([...mockMasters, ...mockMastersYesterday]);
    for (const log of mockYesterdayLogs) {
        await saveActiveLogToIndexedDB(log);
    }

    showSyncToast('✅ 示範資料載入完成！今日已發布課表，請點擊「Claim Workout」體驗！');
    loadWorkouts();
}

// 渲染設定分頁 UI
function renderSettingsPage() {
    document.getElementById('set-email').value = currentUser.email;
    document.getElementById('set-name').value = currentUser.name;
    document.getElementById('set-role').value = currentUser.role;
    document.getElementById('set-group-id').value = currentUser.groupId;
    
    document.getElementById('set-supabase-url').value = localStorage.getItem('glowup_supabase_url') || '';
    document.getElementById('set-supabase-key').value = localStorage.getItem('glowup_supabase_key') || '';
}

function saveSettings() {
    currentUser.email = document.getElementById('set-email').value;
    currentUser.name = document.getElementById('set-name').value;
    currentUser.role = document.getElementById('set-role').value;
    currentUser.groupId = document.getElementById('set-group-id').value;

    localStorage.setItem('glowup_email', currentUser.email);
    localStorage.setItem('glowup_name', currentUser.name);
    localStorage.setItem('glowup_role', currentUser.role);
    localStorage.setItem('glowup_group_id', currentUser.groupId);

    const supUrl = document.getElementById('set-supabase-url').value;
    const supKey = document.getElementById('set-supabase-key').value;

    localStorage.setItem('glowup_supabase_url', supUrl);
    localStorage.setItem('glowup_supabase_key', supKey);

    initSupabase();
    showSyncToast('💾 個人與 API 設定已儲存成功！');
    loadWorkouts();
}

// ==========================================
// 12. UI 渲染細節 (精緻 HTML 裝載)
// ==========================================

async function renderWorkoutPage() {
    const listContainer = document.getElementById('active-workouts-container');
    const claimSection = document.getElementById('claim-workout-section');

    // 1. 如果尚未 Claim 領取今日課表
    if (activeLogs.length === 0) {
        listContainer.style.display = 'none';
        claimSection.style.display = 'block';

        const claimInfo = document.getElementById('claim-master-info');
        if (masterWorkouts.length > 0) {
            const names = masterWorkouts.map(w => w.exercise_name).join('、');
            claimInfo.innerHTML = `今日主課表已發布：<br><strong>${names}</strong>`;
        } else {
            claimInfo.innerHTML = '今日教練尚未發布主課表，或此群組尚無範本。';
        }
        return;
    }

    // 2. 已領取，顯示訓練卡片
    claimSection.style.display = 'none';
    listContainer.style.display = 'block';
    listContainer.innerHTML = '';

    for (const log of activeLogs) {
        const card = document.createElement('div');
        const isCompleted = log.status === 'completed';
        card.className = `card exercise-card ${isCompleted ? 'completed' : ''}`;
        
        // 動作名稱與是否有替換
        const displayName = log.swapped_exercise_name || log.exercise_name;
        const swappedBadge = log.swapped_exercise_id ? '<span class="swapped-badge">已替換</span>' : '';
        const currentExId = log.swapped_exercise_id || log.exercise_id;
        
        // 影片資訊
        const mediaInfo = EXERCISE_MEDIA_DATABASE[currentExId];
        const isCached = await checkIsMediaCached(currentExId);

        // 渲染組數
        let setRowsHtml = '';
        log.sets.forEach(set => {
            const completedClass = set.completed ? 'completed' : '';
            const weightVal = formatWeightDisplay(set.weight_kg);
            
            setRowsHtml += `
                <div class="set-row ${completedClass}">
                    <div class="set-number">${set.set_index}</div>
                    
                    <!-- 重量增減 -->
                    <div class="number-stepper">
                        <button class="stepper-btn" onclick="adjustStepperValue('${log.id}', ${set.set_index}, 'weight', -2.5)">-</button>
                        <input type="number" step="0.1" class="stepper-input" 
                               value="${weightVal}" 
                               onchange="updateLogSet('${log.id}', ${set.set_index}, 'weight', this.value)">
                        <button class="stepper-btn" onclick="adjustStepperValue('${log.id}', ${set.set_index}, 'weight', 2.5)">+</button>
                    </div>

                    <!-- 次數增減 -->
                    <div class="number-stepper">
                        <button class="stepper-btn" onclick="adjustStepperValue('${log.id}', ${set.set_index}, 'reps', -1)">-</button>
                        <input type="number" class="stepper-input" 
                               value="${set.reps}" 
                               onchange="updateLogSet('${log.id}', ${set.set_index}, 'reps', this.value)">
                        <button class="stepper-btn" onclick="adjustStepperValue('${log.id}', ${set.set_index}, 'reps', 1)">+</button>
                    </div>

                    <!-- 是否完成勾選 -->
                    <div class="set-checkbox-wrapper">
                        <input type="checkbox" class="set-checkbox" 
                               ${set.completed ? 'checked' : ''} 
                               onchange="updateLogSet('${log.id}', ${set.set_index}, 'completed', this.checked); loadWorkouts();">
                    </div>

                    <!-- 刪除此組 -->
                    <div style="text-align:center;">
                        <button class="stepper-btn" style="background:rgba(239,68,68,0.05); color:var(--danger); border-color:rgba(239,68,68,0.1);" 
                                onclick="deleteSetFromExercise('${log.id}', ${set.set_index})">✕</button>
                    </div>
                </div>
            `;
        });

        // 預覽按鈕圖示與樣式
        const previewSectionHtml = mediaInfo ? `
            <div class="video-preview-wrapper" id="preview-${log.id}" style="display: none;">
                <video src="${mediaInfo.mediaUrl}" controls loop muted playsinline></video>
                <div class="media-cache-badge ${isCached ? 'cached' : 'uncached'} media-badge-${currentExId}">
                    ${isCached ? '✓ 離線已存檔' : '⚠ 需連線下載'}
                </div>
            </div>
        ` : '';

        card.innerHTML = `
            <div class="exercise-card-header">
                <div class="exercise-info">
                    <div class="exercise-name-row">
                        <span class="exercise-name">${displayName}</span>
                        ${swappedBadge}
                    </div>
                    <div class="exercise-meta">
                        <span>🎯 目標: ${log.target_sets} 組</span>
                        <span>📦 同步狀態: ${log.synced ? '☁ 已雲端備份' : '⚡ 僅儲存於本地'}</span>
                    </div>
                </div>
                <div class="exercise-actions">
                    <button class="btn btn-secondary btn-icon" onclick="toggleMediaPreview('${log.id}')" title="播放動作教學">
                        <i>📹</i>
                    </button>
                    <button class="btn btn-secondary btn-icon" onclick="openOneRepMaxChart('${currentExId}')" title="查看1RM歷史趨勢">
                        <i>📈</i>
                    </button>
                    <button class="btn btn-secondary btn-icon" onclick="openSwapModal('${log.id}')" title="替換此動作">
                        <i>🔄</i>
                    </button>
                    <button class="btn btn-danger btn-icon" onclick="deleteActiveLog('${log.id}')" title="刪除此動作">
                        <i>✕</i>
                    </button>
                </div>
            </div>

            <!-- 隱藏的動作預覽影片區 -->
            ${previewSectionHtml}

            <!-- 組數清單 -->
            <div class="sets-header">
                <div>組</div>
                <div>重量 (${currentUnit.toUpperCase()})</div>
                <div>次數</div>
                <div>完成</div>
                <div>刪除</div>
            </div>
            ${setRowsHtml}

            <div class="add-set-row">
                <button class="btn btn-secondary btn-block" onclick="addSetToExercise('${log.id}')" style="margin-top: 0.5rem; font-size: 0.8rem; padding: 0.4rem;">
                    ＋ 新增一組 (Add Set)
                </button>
            </div>
        `;

        listContainer.appendChild(card);
    }

    // 渲染「新增自訂動作」按鈕於列表底部
    const addCustomBtnContainer = document.createElement('div');
    addCustomBtnContainer.style = 'margin-top: 2rem; display: flex; justify-content: center;';
    addCustomBtnContainer.innerHTML = `
        <button class="btn btn-accent btn-block" onclick="openAddCustomExerciseModal()">
            ＋ 新增自訂訓練動作 (Add Custom Exercise)
        </button>
    `;
    listContainer.appendChild(addCustomBtnContainer);
}

// 展開或隱藏影音教學
function toggleMediaPreview(logId) {
    const previewDiv = document.getElementById(`preview-${logId}`);
    if (previewDiv) {
        const isHidden = previewDiv.style.display === 'none';
        previewDiv.style.display = isHidden ? 'block' : 'none';
        
        const video = previewDiv.querySelector('video');
        if (video) {
            if (isHidden) {
                // 如果快取中存在虛擬路徑 exercise-media/ID，使用虛擬路徑播放，否則會直接走網路 (如果是在線)
                const log = activeLogs.find(l => l.id === logId);
                if (log) {
                    const currentExId = log.swapped_exercise_id || log.exercise_id;
                    video.src = `exercise-media/${currentExId}`;
                }
                video.play().catch(() => {});
            } else {
                video.pause();
            }
        }
    }
}

// 增減數值按鈕輔助
function adjustStepperValue(logId, setIndex, field, delta) {
    const log = activeLogs.find(l => l.id === logId);
    if (!log) return;

    const set = log.sets.find(s => s.set_index === setIndex);
    if (!set) return;

    if (field === 'weight') {
        // 智慧重量調整：KG 步進 2.5kg，LB 步進 5lb
        let step = delta;
        if (currentUnit === 'lb') {
            step = delta > 0 ? 5 : -5;
        } else {
            step = delta > 0 ? 2.5 : -2.5;
        }

        let currentWeightDisplay = formatWeightDisplay(set.weight_kg);
        let newWeightDisplay = Math.max(0, currentWeightDisplay + step);
        
        // 寫入
        updateLogSet(logId, setIndex, 'weight', newWeightDisplay);
    } else if (field === 'reps') {
        let newReps = Math.max(0, set.reps + delta);
        updateLogSet(logId, setIndex, 'reps', newReps);
    }

    triggerHapticFeedback();

    // 重新繪製 UI
    loadWorkouts();
}

// ==========================================
// 13. PWA 初始化 & Service Worker 註冊
// ==========================================

window.addEventListener('DOMContentLoaded', async () => {
    // A. 初始化 IndexedDB
    try {
        await initIndexedDB();
    } catch (e) {
        alert('本地資料庫初始化失敗，可能無法離線使用！');
    }

    // B. 初始化 Supabase 連線
    initSupabase();

    // C. 註冊 PWA Service Worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('[PWA] Service Worker 註冊成功，範疇:', reg.scope))
            .catch(err => console.error('[PWA] Service Worker 註冊失敗:', err));
    }

    // D. 綁定基本 UI 互動事件
    document.getElementById('workout-date-picker').value = selectedDate;
    document.getElementById('workout-date-picker').addEventListener('change', (e) => {
        selectedDate = e.target.value;
        loadWorkouts();
    });

    // KG/LB 開關監聽
    const unitToggle = document.getElementById('unit-toggle-cb');
    unitToggle.checked = currentUnit === 'lb';
    document.getElementById('toggle-unit-indicator').textContent = currentUnit.toUpperCase();
    unitToggle.addEventListener('change', toggleUnit);

    // 關閉 Modal 點擊事件
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
        });
    });

    // E. 綁定全域快速帳號切換選單
    const switcher = document.getElementById('global-account-switcher');
    if (switcher) {
        const currentEmail = currentUser.email;
        if (currentEmail === PRESET_ACCOUNTS.student1.email) switcher.value = 'student1';
        else if (currentEmail === PRESET_ACCOUNTS.student2.email) switcher.value = 'student2';
        else if (currentEmail === PRESET_ACCOUNTS.coach.email) switcher.value = 'coach';
        
        switcher.addEventListener('change', (e) => {
            switchAccount(e.target.value);
        });
    }

    // 預設加載今日課表
    loadWorkouts();
});
