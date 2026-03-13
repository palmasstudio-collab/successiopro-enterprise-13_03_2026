import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import './index.css';

// --- CONFIGURAZIONE CLOUD RUN / DRIVE API ---
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "459844148501-9jqtil56lhpc56g2ddh6ol05jrgc3atu.apps.googleusercontent.com"; 
const GOOGLE_API_KEY = import.meta.env.VITE_GOOGLE_API_KEY || "AIzaSyAlNDPa0a4DKEWErU98IgZ61DJgpa3u9Z8"; 
const ROOT_FOLDER_ID = import.meta.env.VITE_ROOT_FOLDER_ID || "1aY3zA-D3_tAhEFLmasuTCz3JURKeviKP"; 
const SENT_FOLDER_ID = import.meta.env.VITE_SENT_FOLDER_ID || "16_ie96ihd4lJouI8BcrqjjfQS_Rq7Ep0"; 
const DB_FOLDER_ID = import.meta.env.VITE_DB_FOLDER_ID || "13L8CT9j-_Y-_sT6Xp6CEqQ52E0eZaB_Y"; 
const DB_FILE_NAME = "successio_master_db.json";

const GRADI_PARENTELA = [
    "Coniuge",
    "Figlio/a",
    "Nipote (linea retta)",
    "Pronipote (linea retta)",
    "Genitore",
    "Nonno/a",
    "Bisnonno/a",
    "Fratello/Sorella",
    "Nipote (collaterale)",
    "Pronipote (collaterale)",
    "Zio/a",
    "Cugino/a",
    "Altro parente (fino al 6° grado)",
    "Affine",
    "Convivente di fatto",
    "Erede testamentario/Altro"
];

const TIPOLOGIE_PRATICA = [
    "Successione",
    "Voltura",
    "Consulenza",
    "Altro"
];

// --- STATEFUL MOCK DATABASE ---
let MOCK_FOLDERS: DashboardPractice[] = [];
let MOCK_DETAILS: {[key:string]: PracticeDetails} = {};
let MOCK_ECO: EcoTransaction[] = [];
let IS_DB_LOADED = false;

// Funzione di normalizzazione per garantire coerenza tra DB e UI
const normalizeStatus = (s: string): string => {
    const up = (s || '').toUpperCase();
    if (up === 'APERTA' || up === 'OPEN') return 'APERTA';
    if (up === 'IN LAVORAZIONE' || up === 'PROCESSING') return 'IN LAVORAZIONE';
    if (up === 'IN ATTESA DOCUMENTO' || up === 'IN ATTESA DOCUMENTI' || up === 'WAITING') return 'IN ATTESA DOCUMENTO';
    if (up === 'INVIATA' || up === 'SENT') return 'INVIATA';
    if (up === 'CONCLUSA' || up === 'CLOSED') return 'CONCLUSA';
    return up || 'APERTA';
};

const extractAmount = (text: string) => {
    const match = text.match(/[\d\.,]+/);
    if (match) {
        const clean = match[0].replace(/\./g, '').replace(',', '.');
        const val = parseFloat(clean);
        return isNaN(val) ? 0 : val;
    }
    return 0;
};

// --- DRIVE API HELPER FUNCTIONS ---
const DriveAPI = {
    searchFile: async (token: string, name: string, parentId: string) => {
        const q = `name = '${name}' and '${parentId}' in parents and trashed = false`;
        const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id, name)`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        return data.files && data.files.length > 0 ? data.files[0].id : null;
    },
    downloadJson: async (token: string, fileId: string) => {
        const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) return null;
        return await response.json();
    },
    uploadJson: async (token: string, name: string, parentId: string, content: any) => {
        const existingId = await DriveAPI.searchFile(token, name, parentId);
        const metadata = { name, parents: existingId ? undefined : [parentId] };
        const blob = new Blob([JSON.stringify(content)], { type: 'application/json' });
        
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', blob);

        const url = existingId 
            ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
            : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
        
        const method = existingId ? 'PATCH' : 'POST';

        const response = await fetch(url, {
            method: method,
            headers: { 'Authorization': `Bearer ${token}` },
            body: form
        });
        return await response.json();
    },
    createFolder: async (token: string, name: string, parentId: string = 'root') => {
        const metadata = { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] };
        const response = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(metadata)
        });
        if (!response.ok) throw new Error('Errore creazione cartella Drive');
        const data = await response.json();
        return data.id;
    },
    uploadFile: async (token: string, file: File, parentId: string) => {
        const metadata = { name: file.name, parents: [parentId] };
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', file);
        const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: form
        });
        if (!response.ok) throw new Error('Errore upload file');
        return await response.json();
    },
    moveFile: async (token: string, fileId: string, previousParentId: string, newParentId: string) => {
        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${newParentId}&removeParents=${previousParentId}`;
        const response = await fetch(url, { method: 'PATCH', headers: { 'Authorization': `Bearer ${token}` } });
        return response.ok;
    },
    listFolders: async (token: string, parentId: string) => {
        const q = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
        const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id, name, createdTime, description)&orderBy=createdTime desc&pageSize=1000`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) throw new Error('Errore lettura cartelle Drive');
        const data = await response.json();
        return data.files || [];
    }
};

const GAS = {
  token: null as string | null,
  setToken: (t: string) => { GAS.token = t; },
  isAvailable: () => typeof window !== 'undefined' && (window as any).google && (window as any).google.script,
  
  syncToDrive: async () => {
    if (!GAS.token) return;
    try {
        const content = {
            folders: MOCK_FOLDERS,
            details: MOCK_DETAILS,
            eco: MOCK_ECO
        };
        await DriveAPI.uploadJson(GAS.token, DB_FILE_NAME, DB_FOLDER_ID, content);
    } catch (e) { console.error("Errore sincronizzazione DB Drive:", e); }
  },

  loadFromDrive: async (force = false) => {
    if (!GAS.token) return null;
    if (IS_DB_LOADED && !force) return { folders: MOCK_FOLDERS, details: MOCK_DETAILS, eco: MOCK_ECO };
    try {
        const fileId = await DriveAPI.searchFile(GAS.token, DB_FILE_NAME, DB_FOLDER_ID);
        if (fileId) {
            const data = await DriveAPI.downloadJson(GAS.token, fileId);
            if (data) {
                MOCK_FOLDERS = (data.folders || []).map((f: any) => ({ ...f, status: normalizeStatus(f.status), type: f.type || 'Successione' }));
                MOCK_DETAILS = data.details || {};
                Object.keys(MOCK_DETAILS).forEach(k => {
                    MOCK_DETAILS[k].status = normalizeStatus(MOCK_DETAILS[k].status);
                    if (!MOCK_DETAILS[k].type) MOCK_DETAILS[k].type = 'Successione';
                });
                MOCK_ECO = data.eco || [];
                IS_DB_LOADED = true;
                return data;
            }
        }
    } catch (e) { console.error("Errore caricamento DB Drive:", e); }
    return null;
  },

  run: async (fname: string, ...args: any[]) => {
    if (GAS.isAvailable()) {
      return new Promise((resolve, reject) => {
        (window as any).google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[fname](...args);
      });
    }

    if (GAS.token && fname === 'creaCartella') {
        const name = args[0];
        const erediList = args[1] || [];
        try {
            const id = await DriveAPI.createFolder(GAS.token, name, ROOT_FOLDER_ID);
            await DriveAPI.createFolder(GAS.token, "Documenti", id);
            await DriveAPI.createFolder(GAS.token, "Ricevute", id);
            MOCK_FOLDERS.unshift({ id: id, name: name, type: 'Successione', created: new Date().toLocaleDateString(), status: 'APERTA', fee: 0, paid: 0, lastUpdate: new Date().toLocaleDateString() });
            MOCK_DETAILS[id] = { 
                status: 'APERTA', 
                type: 'Successione',
                fee: '', 
                eredi: erediList,
                history: [{date: new Date().toLocaleString(), type:'status', user:'Sistema', text:'Pratica Creata su Drive'}] 
            };
            await GAS.syncToDrive();
            return id;
        } catch (e) { console.error(e); throw e; }
    }

    return new Promise((resolve) => {
        setTimeout(async () => {
          if (fname === 'getExistingSuccessionFolders') {
             await GAS.loadFromDrive();
             if (GAS.token) {
                 try {
                     const activeFiles = await DriveAPI.listFolders(GAS.token, ROOT_FOLDER_ID);
                     const sentFiles = await DriveAPI.listFolders(GAS.token, SENT_FOLDER_ID);
                     const mapDriveFolder = (f: any) => {
                         const existingMock = MOCK_FOLDERS.find(m => m.id === f.id);
                         let displayDate = f.createdTime ? new Date(f.createdTime).toLocaleDateString() : new Date().toLocaleDateString();
                         if (f.description && f.description.length > 5) displayDate = f.description;
                         return {
                             id: f.id, name: f.name, created: displayDate,
                             type: existingMock ? existingMock.type : 'Successione',
                             status: existingMock ? normalizeStatus(existingMock.status) : 'APERTA', 
                             fee: existingMock ? existingMock.fee : 0,
                             paid: existingMock ? existingMock.paid : 0,
                             lastUpdate: f.createdTime ? new Date(f.createdTime).toLocaleDateString() : new Date().toLocaleDateString()
                         };
                     };
                     const activeList = activeFiles.map((f: any) => mapDriveFolder(f));
                     const sentList = sentFiles.map((f: any) => mapDriveFolder(f));
                     const allDriveFolders = [...activeList, ...sentList].sort((a,b) => b.id.localeCompare(a.id));
                     MOCK_FOLDERS = allDriveFolders;
                     resolve(allDriveFolders);
                     return;
                 } catch (e) { console.error("Errore recupero cartelle Drive:", e); }
             }
             resolve([...MOCK_FOLDERS]);
          } else if (fname === 'getPracticeDetails') {
             const id = args[0] as string;
             const det = MOCK_DETAILS[id] || { status: 'APERTA', type: 'Successione', fee: '0', history: [] };
             det.status = normalizeStatus(det.status);
             if (!det.type) det.type = 'Successione';
             resolve(det);
          } else if (fname === 'addLogToPractice') {
             const [id, text, type] = args;
             if (!MOCK_DETAILS[id]) MOCK_DETAILS[id] = { status: 'APERTA', type: 'Successione', fee:'0', history: [] };
             MOCK_DETAILS[id].history.unshift({ date: new Date().toLocaleString(), type: type || 'note', user: 'Io', text: text });
             const folderIdx = MOCK_FOLDERS.findIndex(f => f.id === id);
             if (folderIdx >= 0) {
                 MOCK_FOLDERS[folderIdx].lastUpdate = new Date().toLocaleDateString();
                 if (type === 'payment') {
                     const amt = extractAmount(text);
                     MOCK_FOLDERS[folderIdx].paid = (MOCK_FOLDERS[folderIdx].paid || 0) + amt;
                 }
             }
             await GAS.syncToDrive();
             resolve(true);
          } else if (fname === 'removeLogFromPractice') {
             const [id, logIndex] = args;
             if (MOCK_DETAILS[id]) {
                 const removedLog = MOCK_DETAILS[id].history[logIndex];
                 MOCK_DETAILS[id].history.splice(logIndex, 1);
                 if (removedLog && removedLog.type === 'payment') {
                     const amt = extractAmount(removedLog.text);
                     const folderIdx = MOCK_FOLDERS.findIndex(f => f.id === id);
                     if (folderIdx >= 0) MOCK_FOLDERS[folderIdx].paid = Math.max(0, (MOCK_FOLDERS[folderIdx].paid || 0) - amt);
                 }
             }
             await GAS.syncToDrive();
             resolve(true);
          } else if (fname === 'updatePracticeStatus') {
             const [id, status] = args;
             const normalized = normalizeStatus(status);
             if (GAS.token) {
                 try {
                     if (normalized === 'INVIATA') await DriveAPI.moveFile(GAS.token, id, ROOT_FOLDER_ID, SENT_FOLDER_ID);
                     else await DriveAPI.moveFile(GAS.token, id, SENT_FOLDER_ID, ROOT_FOLDER_ID);
                 } catch (e) { console.error("Errore spostamento cartella Drive:", e); }
             }
             if (!MOCK_DETAILS[id]) MOCK_DETAILS[id] = { status: normalized, type: 'Successione', fee:'0', history: [] };
             MOCK_DETAILS[id].status = normalized;
             MOCK_DETAILS[id].history.unshift({ date: new Date().toLocaleString(), type: 'status', user: 'Sistema', text: `Stato pratica modificato in: ${normalized}` });
             const f = MOCK_FOLDERS.find(x => x.id === id);
             if (f) f.status = normalized;
             await GAS.syncToDrive();
             resolve(true);
          } else if (fname === 'updatePracticeFee') {
             const [id, feeStr] = args;
             if (!MOCK_DETAILS[id]) MOCK_DETAILS[id] = { status: 'APERTA', type: 'Successione', fee: '0', history: [] };
             MOCK_DETAILS[id].fee = feeStr;
             MOCK_DETAILS[id].history.unshift({ date: new Date().toLocaleString(), type: 'fee', user: 'Io', text: `Parcella definita per il cliente: € ${feeStr}` });
             const f = MOCK_FOLDERS.find(x => x.id === id);
             if (f) { f.fee = extractAmount(feeStr); f.lastUpdate = new Date().toLocaleDateString(); }
             await GAS.syncToDrive();
             resolve(true);
          } else if (fname === 'creaCartella') {
             const newId = Math.random().toString(36).substr(2, 5);
             const name = args[0];
             const erediList = args[1] || [];
              const type = args[2] || 'Successione';
              MOCK_FOLDERS.unshift({ id: newId, name: name, type: type, created: new Date().toLocaleDateString(), status: 'APERTA', fee: 0, paid: 0, lastUpdate: new Date().toLocaleDateString() });
             MOCK_DETAILS[newId] = { 
                status: 'APERTA', 
                type: type,
                fee: '', 
                eredi: erediList,
                history: [{date: new Date().toLocaleString(), type:'status', user:'Sistema', text:'Pratica Creata (Locale)'}] 
             };
             await GAS.syncToDrive();
             resolve(newId);
          } else { resolve({ success: true }); }
        }, 300);
    });
  }
};

interface Erede {
  id: string;
  parentela: string;
  nome: string;
  files?: File[];
}

interface LogEntry {
    date: string;
    type: 'note' | 'status' | 'upload' | 'fee' | 'payment';
    user: string;
    text: string;
}

interface PracticeDetails {
    status: string;
    type: string;
    fee?: string;
    history: LogEntry[];
    eredi?: Erede[];
}

interface DashboardPractice {
    id: string;
    name: string;
    type: string;
    created: string;
    status: string;
    fee: number;
    paid: number;
    lastUpdate: string;
}

type TransactionType = 'ENTRATA_PRATICA' | 'S_SPESA_50' | 'S_SPESA_COLLAB' | 'S_PRELIEVO' | 'C_ANTICIPO_50' | 'C_ANTICIPO_STUDIO';

interface EcoTransaction {
    id: string;
    date: string;
    type: TransactionType;
    description: string;
    amount: number;
    refPracticeId?: string;
}

const getStatusColor = (status: string) => {
  const s = normalizeStatus(status);
  switch (s) {
    case 'APERTA': return 'status-aperta';
    case 'IN LAVORAZIONE': return 'status-lavorazione';
    case 'IN ATTESA DOCUMENTO': return 'status-attesa';
    case 'INVIATA': return 'status-inviata';
    case 'CONCLUSA': return 'status-conclusa';
    default: return 'status-default';
  }
};

const getProgressColor = (paid: number, fee: number) => {
  if (fee <= 0) return '#eee';
  const pct = (paid / fee) * 100;
  if (pct >= 100) return '#198754';
  if (pct >= 50) return '#ffc107';
  return '#dc3545';
};

const SuccessioPro = () => {
  const [view, setView] = useState<'STARTUP' | 'NEW' | 'UPDATE'>('STARTUP');
  const [step, setStep] = useState(1);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  
  const [nomeCognome, setNomeCognome] = useState('');
  const [indirizzo, setIndirizzo] = useState('');
  const [tipoPratica, setTipoPratica] = useState('Successione');
  const [immobiliOption, setImmobiliOption] = useState('');
  const [rapportiOption, setRapportiOption] = useState('');
  const [testamentoOption, setTestamentoOption] = useState('');
  const [dichiaranteParentela, setDichiaranteParentela] = useState('');
  const [dichiaranteNome, setDichiaranteNome] = useState('');
  const [dichiaranteCell, setDichiaranteCell] = useState('');
  const [dichiaranteEmail, setDichiaranteEmail] = useState('');
  const [dichiaranteIndirizzo, setDichiaranteIndirizzo] = useState('');
  const [iban, setIban] = useState('');
  const [chkErede, setChkErede] = useState(false);
  const [chkUnicoErede, setChkUnicoErede] = useState(false);
  const [eredi, setEredi] = useState<Erede[]>([]);
  const [files, setFiles] = useState<{[key: string]: File[]}>({});
  const [visureFiles, setVisureFiles] = useState<File[]>([]);
  const [bancaFiles, setBancaFiles] = useState<File[]>([]);

  const [archiveFolders, setArchiveFolders] = useState<DashboardPractice[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [selectedFolderName, setSelectedFolderName] = useState('');
  
  const [dashboardFilter, setDashboardFilter] = useState<'TUTTE'|'DA INCASSARE'|'APERTA'|'IN LAVORAZIONE'|'IN ATTESA DOCUMENTO'|'INVIATA'|'CONCLUSA'>('TUTTE');
  const [dashboardTypeFilter, setDashboardTypeFilter] = useState<string>('TUTTE');

  const [practiceDetails, setPracticeDetails] = useState<PracticeDetails | null>(null);
  const [activeTab, setActiveTab] = useState<'NOTE' | 'UPLOAD'>('NOTE');
  const [newNote, setNewNote] = useState('');
  const [feeInput, setFeeInput] = useState('');
  const [paymentInput, setPaymentInput] = useState('');
  const [showPaymentInput, setShowPaymentInput] = useState(false);

  // Stato dinamico per gli slot delle visure catastali (interno a una pratica aperta)
  const [visureSlots, setVisureSlots] = useState<number[]>([1]);
  
  const [ecoTransactions, setEcoTransactions] = useState<EcoTransaction[]>([]);
  const [newTransDesc, setNewTransDesc] = useState('');
  const [newTransAmount, setNewTransAmount] = useState('');
  const [showEcoPanel, setShowEcoPanel] = useState(false);
  const [tempFiles, setTempFiles] = useState<File[]>([]);
  const [tempNames, setTempNames] = useState<string[]>([]);
  const [popup, setPopup] = useState<{show: boolean, title: string, msg: string}>({show:false, title:'', msg:''});

  const fetchPratiche = useCallback(async () => { 
      try { 
          const data = await GAS.loadFromDrive(true);
          if (data) setEcoTransactions(data.eco || []);
          const list = await GAS.run('getExistingSuccessionFolders') as DashboardPractice[]; 
          setArchiveFolders((list||[]).map(f => ({ ...f, status: normalizeStatus(f.status) }))); 
      } catch(e) { console.error(e); }
  }, []);

  const terminateSession = useCallback(() => {
    localStorage.removeItem('successio_token');
    localStorage.removeItem('successio_token_expiry');
    GAS.setToken('');
    setIsLoggedIn(false);
    setView('STARTUP');
    setPopup({ show: false, title: '', msg: '' });
  }, []);

  const handleLogout = () => { if(confirm("Vuoi disconnettere Google Drive?")) terminateSession(); };

  useEffect(() => {
    const storedToken = localStorage.getItem('successio_token');
    const storedExpiry = localStorage.getItem('successio_token_expiry');
    if (storedToken && storedExpiry && Date.now() < parseInt(storedExpiry)) {
        GAS.setToken(storedToken);
        setIsLoggedIn(true);
        fetchPratiche();
    }
  }, [terminateSession, fetchPratiche]);

  useEffect(() => {
    if (!isLoggedIn) return;
    const interval = setInterval(() => {
        GAS.syncToDrive();
    }, 45000); 
    return () => clearInterval(interval);
  }, [isLoggedIn]);

  const handleGoogleLogin = () => {
    const client = (window as any).google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: (tokenResponse: any) => {
            if (tokenResponse.access_token) {
                const expiryTime = Date.now() + ((tokenResponse.expires_in || 3599) * 1000);
                localStorage.setItem('successio_token', tokenResponse.access_token);
                localStorage.setItem('successio_token_expiry', expiryTime.toString());
                GAS.setToken(tokenResponse.access_token);
                setIsLoggedIn(true);
                fetchPratiche();
            }
        },
    });
    client.requestAccessToken();
  };

  const combinedLedger = useMemo(() => {
      const entries: EcoTransaction[] = [];
      archiveFolders.forEach(folder => {
          const details = MOCK_DETAILS[folder.id];
          if (details && details.history) {
              details.history.filter(h => h.type === 'payment').forEach((h, idx) => {
                  const amt = extractAmount(h.text);
                  if (amt > 0) {
                      entries.push({
                          id: `auto_${folder.id}_${idx}`,
                          date: h.date.split(',')[0],
                          type: 'ENTRATA_PRATICA',
                          description: `${folder.name} - ${h.text}`,
                          amount: amt,
                          refPracticeId: folder.id
                      });
                  }
              });
          }
      });
      return [...ecoTransactions, ...entries].sort((a, b) => b.date.localeCompare(a.date));
  }, [archiveFolders, ecoTransactions]); 

  const ecoStats = useMemo(() => {
     const totalCollected = combinedLedger.filter(t => t.type === 'ENTRATA_PRATICA').reduce((acc, t) => acc + t.amount, 0);
     const taxation = totalCollected * 0.05;
     const netOperating = totalCollected - taxation;
     const expenses50_Studio = ecoTransactions.filter(t => t.type === 'S_SPESA_50').reduce((acc, t) => acc + t.amount, 0);
     const expenses50_Collab = ecoTransactions.filter(t => t.type === 'C_ANTICIPO_50').reduce((acc, t) => acc + t.amount, 0);
     const totalSharedExpenses = expenses50_Studio + expenses50_Collab;
     const residual = netOperating - totalSharedExpenses;
     const collabShareGross = residual * 0.5; 
     const expensesCollab_PaidByStudio = ecoTransactions.filter(t => t.type === 'S_SPESA_COLLAB').reduce((acc, t) => acc + t.amount, 0);
     const withdrawals = ecoTransactions.filter(t => t.type === 'S_PRELIEVO').reduce((acc, t) => acc + t.amount, 0);
     const expensesStudio_PaidByCollab = ecoTransactions.filter(t => t.type === 'C_ANTICIPO_STUDIO').reduce((acc, t) => acc + t.amount, 0);
     const reimbursements = expenses50_Collab + expensesStudio_PaidByCollab;
     const collabBalance = collabShareGross - expensesCollab_PaidByStudio - withdrawals + reimbursements;
     return { totalCollected, taxation, netOperating, collabBalance };
  }, [combinedLedger, ecoTransactions]); 

  const kpiStats = useMemo(() => {
      const active = archiveFolders.filter(f => f.status !== 'CONCLUSA').length;
      const totalFee = archiveFolders.reduce((acc, f) => acc + (f.fee || 0), 0);
      const totalPaid = combinedLedger.filter(t => t.type === 'ENTRATA_PRATICA').reduce((acc, t) => acc + t.amount, 0);
      return { active, totalFee, totalPaid, toCollect: totalFee - totalPaid };
  }, [archiveFolders, combinedLedger]);

  const handleAddEcoTransaction = async (type: TransactionType) => {
      if (!newTransDesc.trim()) { alert('Inserisci una descrizione/causale'); return; }
      const amt = parseFloat(newTransAmount.replace(',', '.'));
      if (isNaN(amt) || amt <= 0) { alert('Inserisci un importo valido'); return; }
      const newTrans: EcoTransaction = { id: Math.random().toString(36).substr(2, 9), date: new Date().toLocaleDateString(), type: type, description: newTransDesc, amount: amt };
      const updated = [newTrans, ...ecoTransactions];
      setEcoTransactions(updated);
      MOCK_ECO = updated;
      await GAS.syncToDrive();
      setNewTransDesc(''); setNewTransAmount('');
  };

  const handleRemoveEcoTransaction = async (id: string) => { 
      if(confirm('Rimuovere questa voce dalla prima nota?')) {
          const updated = ecoTransactions.filter(t => t.id !== id);
          setEcoTransactions(updated);
          MOCK_ECO = updated;
          await GAS.syncToDrive();
      }
  };

  const filteredPractices = useMemo(() => {
      return archiveFolders.filter(f => {
          const normalizedF = normalizeStatus(f.status);
          
          // Filtro per Stato
          let matchStatus = false;
          if (dashboardFilter === 'TUTTE') matchStatus = true;
          else if (dashboardFilter === 'DA INCASSARE') matchStatus = (f.fee || 0) > (f.paid || 0);
          else matchStatus = normalizedF === dashboardFilter;

          // Filtro per Tipologia
          let matchType = false;
          if (dashboardTypeFilter === 'TUTTE') matchType = true;
          else matchType = f.type === dashboardTypeFilter;

          return matchStatus && matchType;
      });
  }, [archiveFolders, dashboardFilter, dashboardTypeFilter]);

  const totalPaidSingle = useMemo(() => {
    const f = archiveFolders.find(x => x.id === selectedFolderId);
    return f ? (f.paid || 0) : 0;
  }, [archiveFolders, selectedFolderId]);

  const handleBatchUpload = async () => {
    if (!selectedFolderId || tempFiles.length === 0) return;
    
    setPopup({show: true, title: 'Caricamento', msg: `Upload di ${tempFiles.length} file in corso...`});
    
    try {
        for (let i = 0; i < tempFiles.length; i++) {
            const file = tempFiles[i];
            const originalName = file.name.split('.').slice(0, -1).join('.') || 'DOC';
            const customName = tempNames[i].trim() || originalName;
            const basePracticeName = selectedFolderName.replace(/\s+/g, '_').toUpperCase();
            
            // Rinomina il file usando il nome personalizzato (o quello originale se non modificato)
            const renamed = renameFile(file, `${basePracticeName}_${customName.toUpperCase()}`);
            
            if (GAS.token) await DriveAPI.uploadFile(GAS.token, renamed, selectedFolderId);
            const logMsg = `Caricato file: ${renamed.name}`;
            await GAS.run('addLogToPractice', selectedFolderId, logMsg, 'upload');
        }
        await loadPracticeDetails(selectedFolderId);
        setTempFiles([]);
        setTempNames([]);
        setPopup({show: false, title: '', msg: ''});
    } catch (err) { 
        alert('Errore upload'); 
        setPopup({show: false, title: '', msg: ''}); 
    }
  };

  const handleReceiptUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: string, heirName?: string) => {
    if (!selectedFolderId || !e.target.files?.length) return;
    const filesArray = Array.from(e.target.files);
    
    setPopup({show: true, title: 'Caricamento', msg: `Upload di ${filesArray.length} file in corso...`});
    
    try {
        for (let i = 0; i < filesArray.length; i++) {
            const file = filesArray[i];
            const basePracticeName = selectedFolderName.replace(/\s+/g, '_').toUpperCase();
            const heirTag = heirName ? `_${heirName.replace(/\s+/g, '_').toUpperCase()}` : '';
            const suffix = filesArray.length > 1 ? `_${i + 1}` : '';
            const renamed = renameFile(file, `${basePracticeName}${heirTag}_${type.toUpperCase()}${suffix}`);
            
            if (GAS.token) await DriveAPI.uploadFile(GAS.token, renamed, selectedFolderId);
            const logMsg = heirName ? `Caricato ${type} per ${heirName} (${renamed.name})` : `Caricato file: ${renamed.name}`;
            await GAS.run('addLogToPractice', selectedFolderId, logMsg, 'upload');
        }
        await loadPracticeDetails(selectedFolderId);
        setPopup({show: false, title: '', msg: ''});
    } catch (err) { alert('Errore upload'); setPopup({show: false, title: '', msg: ''}); }
  };

  const renameFile = (originalFile: File, newNameWithoutExt: string) => {
      const ext = originalFile.name.split('.').pop();
      const newName = `${newNameWithoutExt}.${ext}`.toUpperCase().replace(/\s+/g, '_');
      return new File([originalFile], newName, { type: originalFile.type });
  };

  const loadPracticeDetails = async (id: string) => {
    try {
        const details = await GAS.run('getPracticeDetails', id) as PracticeDetails;
        details.status = normalizeStatus(details.status);
        setPracticeDetails(details);
        setFeeInput(details.fee?.toString() || '');
        setVisureSlots([1]); // Reset slot visure quando si apre una nuova pratica
    } catch (e) { console.error(e); }
  };

  const openPractice = async (id: string, name: string) => { setSelectedFolderId(id); setSelectedFolderName(name); await loadPracticeDetails(id); };
  const closePractice = () => { setSelectedFolderId(''); setSelectedFolderName(''); setPracticeDetails(null); fetchPratiche(); };
  
  const handleChangeStatus = async (newStatus: string) => { 
      const normalized = normalizeStatus(newStatus);
      await GAS.run('updatePracticeStatus', selectedFolderId, normalized); 
      await loadPracticeDetails(selectedFolderId); 
      setArchiveFolders(prev => prev.map(f => f.id === selectedFolderId ? {...f, status: normalized} : f)); 
  };

  const handleUpdateFee = async () => { await GAS.run('updatePracticeFee', selectedFolderId, feeInput); await loadPracticeDetails(selectedFolderId); await fetchPratiche(); };
  const handleAddPayment = async () => { await GAS.run('addLogToPractice', selectedFolderId, `Incasso: € ${paymentInput}`, 'payment'); setPaymentInput(''); setShowPaymentInput(false); await loadPracticeDetails(selectedFolderId); await fetchPratiche(); };
  const handleAddNote = async () => { if(!newNote.trim()) return; await GAS.run('addLogToPractice', selectedFolderId, newNote, 'note'); setNewNote(''); await loadPracticeDetails(selectedFolderId); };
  const handleRemoveLog = async (index: number, type: string) => { if(confirm('Sei sicuro?')) { await GAS.run('removeLogFromPractice', selectedFolderId, index); await loadPracticeDetails(selectedFolderId); if(type === 'payment') await fetchPratiche(); } };

  const handleBackHome = () => { setView('STARTUP'); setStep(1); setNomeCognome(''); setIndirizzo(''); setFiles({}); setVisureFiles([]); setBancaFiles([]); setEredi([]); };
  
  const handleFileChange = (key: string, e: React.ChangeEvent<HTMLInputElement>) => { 
    if (e.target.files?.length) {
      const selected = Array.from(e.target.files);
      setFiles(prev => ({ ...prev, [key]: selected })); 
    }
  };

  const handleChkEredeChange = (checked: boolean) => { setChkErede(checked); setEredi([]); if (checked) { setChkUnicoErede(false); aggiungiErede({ parentela: dichiaranteParentela, nome: dichiaranteNome }); } };
  const handleChkUnicoEredeChange = (checked: boolean) => { setChkUnicoErede(checked); setEredi([]); if (checked) { setChkErede(false); aggiungiErede({ parentela: dichiaranteParentela, nome: dichiaranteNome }); } };
  const handleEredeChange = (id: string, field: keyof Erede, val: any) => setEredi(prev => prev.map(e => e.id === id ? { ...e, [field]: val } : e));
  const handleRemoveErede = (id: string) => setEredi(prev => prev.filter(e => e.id !== id));
  
  const handleEredeFiles = (id: string, e: React.ChangeEvent<HTMLInputElement>) => { 
    if (e.target.files?.length) {
      handleEredeChange(id, 'files', Array.from(e.target.files));
    }
  };

  const aggiungiErede = (pref?: {parentela: string, nome: string}) => setEredi(prev => [...prev, { id: Math.random().toString(36).substr(2, 9), parentela: pref?.parentela || '', nome: pref?.nome || '', files: [] }]);

  // Funzione per generare il PDF di riepilogo
  const generateSummaryPDF = () => {
    const doc = new jsPDF();
    const margin = 15;
    let y = 20;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text("VERBALE RICEZIONE DOCUMENTI", 105, y, { align: "center" });
    y += 15;

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(`Pratica generata il: ${new Date().toLocaleString()}`, margin, y);
    y += 10;

    doc.line(margin, y, 210 - margin, y);
    y += 10;

    // Sezione Decuius
    doc.setFont("helvetica", "bold");
    doc.text("DATI DECUIUS", margin, y);
    y += 7;
    doc.setFont("helvetica", "normal");
    doc.text(`Nominativo: ${nomeCognome}`, margin, y);
    y += 5;
    doc.text(`Residenza: ${indirizzo}`, margin, y);
    y += 5;
    doc.text(`Immobili: ${immobiliOption || 'N/D'} | Rapporti Bancari: ${rapportiOption || 'N/D'} | Testamento: ${testamentoOption || 'N/D'}`, margin, y);
    y += 15;

    // Sezione Dichiarante
    doc.setFont("helvetica", "bold");
    doc.text("DATI DICHIARANTE / CONTATTO", margin, y);
    y += 7;
    doc.setFont("helvetica", "normal");
    doc.text(`Nominativo: ${dichiaranteNome} (${dichiaranteParentela})`, margin, y);
    y += 5;
    doc.text(`Contatti: ${dichiaranteCell} - ${dichiaranteEmail}`, margin, y);
    y += 5;
    doc.text(`IBAN per rimborsi: ${iban || 'N/D'}`, margin, y);
    y += 15;

    // Sezione Eredi
    if (eredi.length > 0) {
        doc.setFont("helvetica", "bold");
        doc.text("ALBERO EREDITARIO", margin, y);
        y += 7;
        doc.setFont("helvetica", "normal");
        eredi.forEach((e, idx) => {
            doc.text(`${idx + 1}. ${e.nome} - Parentela: ${e.parentela}`, margin + 5, y);
            y += 5;
        });
        y += 10;
    }

    doc.setFont("helvetica", "italic");
    doc.setFontSize(8);
    doc.text("Documento generato automaticamente da SuccessioPro Enterprise.", margin, 280);

    return doc.output('blob');
  };

  const handleSubmitNewPractice = async () => {
    setPopup({show: true, title: 'Elaborazione', msg: 'Rinomina file e creazione cartella...'});
    const baseName = nomeCognome.replace(/\s+/g, '_').toUpperCase();
    const filesToUpload: File[] = [];

    // Gestione Fascicolo Unico
    if (files['docCompleto']) {
      files['docCompleto'].forEach((f, i) => filesToUpload.push(renameFile(f, `${baseName}_DOC_COMPLETO${files['docCompleto'].length > 1 ? `_${i+1}` : ''}`)));
    } else {
        // Altri documenti
        const keys = ['docIdentita','cfDecuius','certificato','docIban','docIdDichiarante','cfDichiarante','testamentoFile','altriDoc'];
        keys.forEach(k => { 
          if(files[k]) {
            files[k].forEach((f, i) => filesToUpload.push(renameFile(f, `${baseName}_${k.toUpperCase()}${files[k].length > 1 ? `_${i+1}` : ''}`)));
          }
        });
        
        visureFiles.forEach((f, i) => filesToUpload.push(renameFile(f, `${baseName}_VISURA_${i+1}`)));
        bancaFiles.forEach((f, i) => filesToUpload.push(renameFile(f, `${baseName}_CONTEGGIO_${i+1}`)));
        
        eredi.forEach((er, i) => { 
          if(er.files && er.files.length > 0) {
            er.files.forEach((f, j) => {
               filesToUpload.push(renameFile(f, `${baseName}_EREDE_${i+1}_${er.nome.replace(/\s+/g,'_').toUpperCase()}${er.files!.length > 1 ? `_${j+1}` : ''}`)); 
            });
          }
        });
    }

    try {
      const folderId = await GAS.run('creaCartella', nomeCognome, eredi.map(e=>({id:e.id, nome:e.nome, parentela:e.parentela})), tipoPratica);
      
      if (GAS.token) {
        // Carica i documenti selezionati
        for (const file of filesToUpload) await DriveAPI.uploadFile(GAS.token, file, folderId as string);

        // Genera e carica il PDF di riepilogo
        setPopup({show: true, title: 'PDF', msg: 'Generazione riepilogo pratica...'});
        const pdfBlob = generateSummaryPDF();
        const pdfFile = new File([pdfBlob], `RIEPILOGO_PRATICA_${baseName}.pdf`, { type: 'application/pdf' });
        await DriveAPI.uploadFile(GAS.token, pdfFile, folderId as string);
      }

      setPopup({show: true, title: 'Completato', msg: '✅ Pratica creata e riepilogo generato.'});
      setTimeout(() => { setPopup({show:false, title:'', msg:''}); fetchPratiche(); setView('UPDATE'); }, 1500);
    } catch (err: any) { setPopup({show: true, title: 'Errore', msg: err.message || JSON.stringify(err)}); }
  };

  const getTransactionLabel = (type: TransactionType) => {
    switch (type) {
      case 'ENTRATA_PRATICA': return 'Incasso Pratica (+)';
      case 'S_SPESA_50': return 'Spesa Studio 50% (-)';
      case 'S_SPESA_COLLAB': return 'Spesa Collab (-)';
      case 'S_PRELIEVO': return 'Prelievo Cassa (-)';
      case 'C_ANTICIPO_50': return 'Anticipo Collab 50% (+)';
      case 'C_ANTICIPO_STUDIO': return 'Anticipo Studio 100% (+)';
      default: return type;
    }
  };

  return (
    <div className="box" role="main">
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20, position:'relative', zIndex:50}}>
          <div style={{width:100}}>
              {!isLoggedIn ? (
                  <button onClick={handleGoogleLogin} className="btn-outline" style={{display:'flex', alignItems:'center', gap:5}}><svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.21.81-.63z"/><path fill="#EA4335" d="M12 4.36c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.09 14.97 0 12 0 7.7 0 3.99 2.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>Login</button>
              ) : (
                  <div style={{display:'flex', flexDirection:'column', alignItems:'center'}}><span style={{fontSize:'0.8em', color:'green'}}>✅ Drive On</span><span style={{fontSize:'0.6em', color:'#888'}}>Auto-Sync Attivo</span><button onClick={handleLogout} className="btn-outline" style={{fontSize:'0.7em', padding:'2px 8px', color:'#dc3545', marginTop: 4}}>Esci</button></div>
              )}
          </div>
          <h2 style={{margin:0, flex:1, textAlign:'center'}}>Gestione Documenti Successioni</h2>
          <div style={{width:100, display:'flex', justifyContent:'flex-end'}}>{view !== 'STARTUP' && <button className="btn-accent" onClick={handleBackHome}>🏠 Home</button>}</div>
      </div>

      {view === 'STARTUP' && (
        <div className="animate-in fade-in">
          <div className="startup">
            <button className="big big-new" onClick={() => setView('NEW')}>🆕 Nuova Pratica</button>
            <button className="big big-update" onClick={() => { setView('UPDATE'); fetchPratiche(); }}>📂 Archivio Pratiche Studio</button>
          </div>

          {isLoggedIn && (
            <div className="eco-box" style={{marginTop: 30}}>
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', borderBottom:'1px solid #eee', paddingBottom:10, marginBottom:15}}>
                    <h3 style={{margin:0, fontSize:'1.1em'}}>📊 Gestione Economica & Prima Nota</h3>
                    <button className="btn-outline" onClick={()=>setShowEcoPanel(!showEcoPanel)}>{showEcoPanel ? 'Chiudi' : 'Espandi'}</button>
                </div>

                {showEcoPanel && (
                <div className="animate-in">
                    <div style={{display:'flex', gap:10, marginBottom:15}}>
                        <input type="text" value={newTransDesc} onChange={e=>setNewTransDesc(e.target.value)} placeholder="Descrizione operazione..." style={{flex:3}} />
                        <input type="text" value={newTransAmount} onChange={e=>setNewTransAmount(e.target.value)} placeholder="Importo €" style={{flex:1}} />
                    </div>
                    
                    <div style={{display:'flex', gap:6, flexWrap:'wrap', marginBottom:20}}>
                        <button className="btn-outline" style={{borderColor:'#dc3545', color:'#dc3545'}} onClick={()=>handleAddEcoTransaction('S_SPESA_50')}>Spesa 50% (Studio)</button>
                        <button className="btn-outline" style={{borderColor:'#198754', color:'#198754'}} onClick={()=>handleAddEcoTransaction('C_ANTICIPO_50')}>Spesa 50% (Collab)</button>
                        <button className="btn-outline" style={{borderColor:'#dc3545', color:'#dc3545'}} onClick={()=>handleAddEcoTransaction('S_SPESA_COLLAB')}>Spesa Collab (da Studio)</button>
                        <button className="btn-outline" style={{borderColor:'#2b3a67', color:'#2b3a67'}} onClick={()=>handleAddEcoTransaction('S_PRELIEVO')}>Prelievo</button>
                    </div>

                    <div style={{display:'grid', gridTemplateColumns:'1fr 2fr', gap:20}}>
                        <div style={{borderRight:'1px solid #eee', paddingRight:15}}>
                            <div className="eco-row"><span>Lordo Totale</span><b>€ {ecoStats.totalCollected.toFixed(2)}</b></div>
                            <div className="eco-row"><span>Tasse (5%)</span><b className="text-red">€ {ecoStats.taxation.toFixed(2)}</b></div>
                            <div className="eco-row highlight"><span>Netto Operativo</span><b>€ {ecoStats.netOperating.toFixed(2)}</b></div>
                            <div style={{marginTop:30, paddingTop:15, borderTop:'1px solid #eee'}}>
                                <div style={{fontSize:'0.8em', color:'#666', textTransform:'uppercase'}}>Saldo Collaboratore</div>
                                <div style={{fontSize:'1.8em', fontWeight:800, color:'#0d6efd'}}>€ {ecoStats.collabBalance.toFixed(2)}</div>
                            </div>
                        </div>

                        <div style={{maxHeight:300, overflowY:'auto'}}>
                            <table className="trans-table">
                                <thead><tr><th>Data</th><th>Tipo</th><th>Descrizione</th><th>Importo</th><th>Az.</th></tr></thead>
                                <tbody>
                                    {combinedLedger.map(t => (
                                        <tr key={t.id} className="trans-row">
                                            <td>{t.date}</td>
                                            <td><span className={t.type==='ENTRATA_PRATICA'?'badge-green':'badge-red'}>{getTransactionLabel(t.type).split('(')[0]}</span></td>
                                            <td>{t.description}</td>
                                            <td>€ {t.amount.toFixed(2)}</td>
                                            <td>{!t.id.startsWith('auto_') && <button onClick={()=>handleRemoveEcoTransaction(t.id)}>🗑</button>}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
                )}
            </div>
          )}
        </div>
      )}

      {view === 'NEW' && (
         <div className="animate-in fade-in">
            <div style={{textAlign:'center', marginBottom:12}}>
                {[1,2,3,4].map(i => <span key={i} className={`wizard-step ${step===i?'active':''}`}>{i}</span>)}
             </div>
             <div className={step !== 1 ? 'hidden' : ''}>
                 <label>Tipologia Pratica:</label>
                 <select value={tipoPratica} onChange={e=>setTipoPratica(e.target.value)} style={{marginBottom:10}}>
                     {TIPOLOGIE_PRATICA.map(t => <option key={t} value={t}>{t}</option>)}
                 </select>
                 <label>Decuius:</label><input type="text" value={nomeCognome} onChange={e=>setNomeCognome(e.target.value)} placeholder="Nome e Cognome" />
                 <input type="text" value={indirizzo} onChange={e=>setIndirizzo(e.target.value)} placeholder="Indirizzo residenza" style={{marginTop:8}} />
                 <div style={{display:'flex', gap:8, marginTop:6}}>
                    <div style={{flex:1}}><label>Immobili</label><select value={immobiliOption} onChange={e=>setImmobiliOption(e.target.value)}><option value="">--</option><option value="Si">Sì</option><option value="No">No</option></select></div>
                    <div style={{flex:1}}><label>Rapporti bancari</label><select value={rapportiOption} onChange={e=>setRapportiOption(e.target.value)}><option value="">--</option><option value="Si">Sì</option><option value="No">No</option></select></div>
                 </div>
                 <div style={{marginTop:6}}><label>Testamento</label><select value={testamentoOption} onChange={e=>setTestamentoOption(e.target.value)}><option value="">--</option><option value="Si">Sì</option><option value="No">No</option></select></div>
             </div>
             
             <div className={step !== 2 ? 'hidden' : ''}>
                 <label>Dichiarante:</label>
                 <select value={dichiaranteParentela} onChange={e=>setDichiaranteParentela(e.target.value)}>
                     <option value="">Grado parentela...</option>
                     {GRADI_PARENTELA.map(g => <option key={g} value={g}>{g}</option>)}
                 </select>
                 <input type="text" value={dichiaranteNome} onChange={e=>setDichiaranteNome(e.target.value)} placeholder="Nome e Cognome" style={{marginTop:8}} />
                 <div style={{display:'flex', gap:8, marginTop:8}}><input type="tel" value={dichiaranteCell} onChange={e=>setDichiaranteCell(e.target.value)} placeholder="Cellulare" /><input type="email" value={dichiaranteEmail} onChange={e=>setDichiaranteEmail(e.target.value)} placeholder="Email" /></div>
                 <input type="text" value={iban} onChange={e=>setIban(e.target.value)} placeholder="IBAN" style={{marginTop:8}} />
             </div>

             <div className={step !== 3 ? 'hidden' : ''}>
                 <div style={{display:'flex', gap:20, margin:'10px 0'}}><label><input type="checkbox" checked={chkErede} onChange={e=>handleChkEredeChange(e.target.checked)} /> Altri eredi</label><label><input type="checkbox" checked={chkUnicoErede} onChange={e=>handleChkUnicoEredeChange(e.target.checked)} /> Unico erede</label></div>
                 {eredi.map(erede => (
                    <div key={erede.id} className="erede-section animate-in">
                        <div style={{display:'flex', gap:8}}>
                            <select value={erede.parentela} onChange={e=>handleEredeChange(erede.id,'parentela',e.target.value)}>
                                <option value="">Grado...</option>
                                {GRADI_PARENTELA.map(g => <option key={g} value={g}>{g}</option>)}
                            </select>
                            <input type="text" value={erede.nome} onChange={e=>handleEredeChange(erede.id,'nome',e.target.value)} placeholder="Nome" />
                        </div>
                        <label style={{fontSize:'0.8em', marginTop:10}}>Documenti Erede (Multipli supportati):</label>
                        <input type="file" multiple onChange={e=>handleEredeFiles(erede.id, e)} />
                    </div>
                 ))}
                 {chkErede && <button className="btn-add" onClick={()=>aggiungiErede()}>+ Aggiungi Erede</button>}
             </div>

             <div className={step !== 4 ? 'hidden' : ''}>
                 <div style={{background:'#eef', padding:15, borderRadius:8, border:'1px dashed #2b3a67', marginBottom:15}}>
                    <label>📂 Fascicolo Unico (Supporta più file selezionati)</label>
                    <input type="file" multiple onChange={e=>handleFileChange('docCompleto', e)} />
                 </div>
                 <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
                    {['docIdentita','cfDecuius','certificato','docIban','docIdDichiarante','cfDichiarante'].map(k => (
                        <div key={k}><label style={{fontSize:'0.8em'}}>{k.toUpperCase()} (Multipli)</label><input type="file" multiple onChange={(e)=>handleFileChange(k, e)} /></div>
                    ))}
                 </div>
             </div>

             <div className="controls">
                {step > 1 && <button className="btn-add" onClick={() => setStep(s=>s-1)}>◀ Indietro</button>}
                <button className="btn-secondary" onClick={() => { if(step<4)setStep(s=>s+1); else handleSubmitNewPractice(); }}>{step<4?'Avanti ▶':'Invia Pratica'}</button>
             </div>
         </div>
      )}

      {view === 'UPDATE' && (
        <div className="animate-in fade-in">
           {!selectedFolderId ? (
              <div>
                 <div className="kpi-container">
                    <div className="kpi-card"><div className="kpi-label">Attive</div><div className="kpi-value">{kpiStats.active}</div></div>
                    <div className="kpi-card"><div className="kpi-label">Incassato</div><div className="kpi-value" style={{color:'green'}}>€ {kpiStats.totalPaid.toFixed(0)}</div></div>
                    <div className="kpi-card" style={{borderLeft:'4px solid red'}}><div className="kpi-label">Da Incassare</div><div className="kpi-value" style={{color:'red'}}>€ {kpiStats.toCollect.toFixed(0)}</div></div>
                 </div>

                 <div className="filters-bar" style={{marginBottom:15}}>
                    {['TUTTE','DA INCASSARE','APERTA','IN LAVORAZIONE','IN ATTESA DOCUMENTO','INVIATA','CONCLUSA'].map(f => (
                      <button key={f} className={`filter-btn ${dashboardFilter===f?'active':''}`} onClick={()=>setDashboardFilter(f as any)}>{f}</button>
                    ))}
                 </div>
                 <div className="filters-bar" style={{marginBottom:15, background:'#f8f9fa', padding:10, borderRadius:8}}>
                    <span style={{fontSize:'0.85em', fontWeight:700, marginRight:10}}>Filtra per Tipologia:</span>
                    {['TUTTE', ...TIPOLOGIE_PRATICA].map(t => (
                      <button key={t} className={`filter-btn ${dashboardTypeFilter===t?'active':''}`} onClick={()=>setDashboardTypeFilter(t)} style={{fontSize:'0.75em', padding:'4px 10px'}}>{t}</button>
                    ))}
                 </div>
                 <div style={{overflowX:'auto'}}><table className="dashboard-table">
                    <thead><tr><th>Cliente</th><th>Tipo</th><th>Stato</th><th>Parcella (€)</th><th>Incassato (€)</th><th>Progresso</th><th>Azioni</th></tr></thead>
                    <tbody>{filteredPractices.map(f => (
                      <tr key={f.id}>
                        <td style={{fontWeight:600}}>{f.name}</td>
                        <td style={{fontSize:'0.85em', color:'#666'}}>{f.type}</td>
                        <td><span className={`status-badge ${getStatusColor(f.status)}`}>{normalizeStatus(f.status)}</span></td>
                        <td style={{fontWeight:600}}>€ {f.fee.toFixed(2)}</td>
                        <td style={{fontWeight:600, color:'green'}}>€ {f.paid.toFixed(2)}</td>
                        <td style={{width:100}}><div className="progress-bg"><div className="progress-fill" style={{width: `${f.fee>0 ? (f.paid/f.fee)*100 : 0}%`, background: getProgressColor(f.paid, f.fee)}}></div></div></td>
                        <td><button className="btn-secondary" style={{padding:'4px 8px'}} onClick={()=>openPractice(f.id, f.name)}>Dettagli</button></td>
                      </tr>
                    ))}</tbody>
                 </table></div>
              </div>
           ) : (
               <div className="animate-in fade-in">
                   <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', borderBottom:'1px solid #eee', paddingBottom:10, marginBottom:15}}>
                       <div style={{display:'flex', gap:10}}>
                           <button className="btn-outline" onClick={closePractice}>⬅ Indietro</button>
                           <a href={`https://drive.google.com/drive/folders/${selectedFolderId}`} target="_blank" rel="noreferrer" className="btn-outline" style={{textDecoration:'none', color:'inherit', display:'flex', alignItems:'center'}}>📂 Cartella Drive</a>
                       </div>
                       <h3 style={{margin:0}}>{selectedFolderName}</h3>
                       
                       <select 
                           value={normalizeStatus(practiceDetails?.status || 'APERTA')} 
                           onChange={(e) => handleChangeStatus(e.target.value)} 
                           className={`status-badge ${getStatusColor(practiceDetails?.status||'')}`} 
                           style={{border:'2px solid rgba(255,255,255,0.3)', cursor:'pointer', padding:'4px 10px', borderRadius:'6px'}}
                       >
                           <option value="APERTA">APERTA</option>
                           <option value="IN LAVORAZIONE">IN LAVORAZIONE</option>
                           <option value="IN ATTESA DOCUMENTO">IN ATTESA DOCUMENTO</option>
                           <option value="INVIATA">INVIATA</option>
                           <option value="CONCLUSA">CONCLUSA</option>
                       </select>
                   </div>
                   
                   <div className="fee-box">
                      <div className="fee-col"><label>Parcella (€)</label><div style={{display:'flex', gap:4}}><input type="text" value={feeInput} onChange={e=>setFeeInput(e.target.value)} /><button className="btn-secondary" onClick={handleUpdateFee}>OK</button></div></div>
                      <div className="fee-col" style={{borderLeft:'1px solid #eee', paddingLeft: 10}}><label>Incassato</label><div style={{fontSize:'1.4em', fontWeight:'bold', color:'green'}}>€ {totalPaidSingle.toFixed(2)}</div></div>
                      <div className="fee-col" style={{display:'flex', alignItems:'flex-end'}}>{!showPaymentInput ? <button className="btn-success" onClick={()=>setShowPaymentInput(true)}>+ Registra Pagamento</button> : <div style={{display:'flex', gap:4}}><input type="text" value={paymentInput} onChange={e=>setPaymentInput(e.target.value)} placeholder="0.00" /><button className="btn-success" onClick={handleAddPayment}>Salva</button></div>}</div>
                   </div>

                   <div className="tabs"><div className={`tab ${activeTab === 'NOTE' ? 'active' : ''}`} onClick={()=>setActiveTab('NOTE')}>Cronologia</div><div className={`tab ${activeTab === 'UPLOAD' ? 'active' : ''}`} onClick={()=>setActiveTab('UPLOAD')}>Caricamento File</div></div>
                   
                   {activeTab === 'NOTE' && (
                       <div>
                           <div style={{display:'flex', gap:8}}><textarea value={newNote} onChange={e=>setNewNote(e.target.value)} placeholder="Scrivi una nota..." style={{flex:1}} /><button className="btn-accent" style={{height:40, marginTop:6}} onClick={handleAddNote}>Aggiungi</button></div>
                           <div className="timeline-container">{practiceDetails?.history.map((log, idx) => (
                               <div key={idx} className="timeline-item"><div className="timeline-date">{log.date}</div><div className="timeline-content"><b>{log.type.toUpperCase()}</b>: {log.text} {log.type === 'payment' && <button onClick={()=>handleRemoveLog(idx, log.type)} style={{fontSize:'0.7em', color:'red', marginLeft:10}}>Annulla</button>}</div></div>
                           ))}</div>
                       </div>
                   )}
                   
                   {activeTab === 'UPLOAD' && (
                       <div className="animate-in">
                           {/* Sezione Nuova: Visure Catastali con Slot Multipli */}
                           <div className="doc-section-card" style={{borderLeft: '4px solid #0d6efd'}}>
                               <h4 style={{margin:'0 0 10px 0', fontSize:'1em', color:'#2b3a67', display:'flex', alignItems:'center', gap:8}}>
                                   🏠 Visure Catastali
                               </h4>
                               <div style={{display:'flex', flexDirection:'column', gap:10}}>
                                   {visureSlots.map((slotNum) => (
                                       <div key={slotNum} style={{display:'flex', gap:10, alignItems:'center', background:'#f0f4f8', padding:10, borderRadius:8, border: '1px solid #d1d9e6'}}>
                                           <label style={{margin:0, flex:1, fontSize:'0.85em', fontWeight:600}}>Visura #{slotNum}:</label>
                                           <input 
                                               type="file" 
                                               multiple
                                               onChange={(e) => handleReceiptUpload(e, `VISURA_${slotNum}`)} 
                                               style={{width:'auto', fontSize:'0.8em', background:'transparent', border:'none'}} 
                                           />
                                       </div>
                                   ))}
                                   <button 
                                       className="btn-outline" 
                                       style={{marginTop:5, borderColor:'#0d6efd', color:'#0d6efd', alignSelf:'flex-start', padding: '8px 15px', fontWeight:600}}
                                       onClick={() => setVisureSlots(prev => [...prev, prev.length + 1])}
                                   >
                                       + Aggiungi un altro slot Visura
                                   </button>
                               </div>
                           </div>

                           <div className="doc-section-card" style={{marginTop:20}}>
                               <h4 style={{margin:'0 0 10px 0', fontSize:'0.9em', color:'#2b3a67'}}>📄 Altri Documenti Pratica</h4>
                               
                               {tempFiles.length === 0 ? (
                                   <div style={{display:'flex', gap:10, alignItems:'center', background:'#f8f9fa', padding:10, borderRadius:8}}>
                                       <label style={{margin:0, flex:1, fontSize:'0.85em'}}>Seleziona uno o più file:</label>
                                       <input 
                                           type="file" 
                                           multiple 
                                           onChange={(e) => {
                                               if (e.target.files) {
                                                   const files = Array.from(e.target.files);
                                                   setTempFiles(files);
                                                   setTempNames(files.map(f => f.name.split('.').slice(0, -1).join('.')));
                                               }
                                           }} 
                                           style={{width:'auto', marginTop: 0}} 
                                       />
                                   </div>
                               ) : (
                                   <div style={{background:'#f8f9fa', padding:12, borderRadius:8}}>
                                       <div style={{fontSize:'0.85em', fontWeight:700, marginBottom:10, color:'#555'}}>File da caricare (puoi modificare i nomi):</div>
                                       <div style={{display:'flex', flexDirection:'column', gap:8}}>
                                           {tempFiles.map((file, idx) => (
                                               <div key={idx} style={{display:'flex', gap:10, alignItems:'center'}}>
                                                   <span style={{fontSize:'0.75em', color:'#888', width:20}}>{idx+1}.</span>
                                                   <input 
                                                       type="text" 
                                                       value={tempNames[idx]} 
                                                       onChange={(e) => {
                                                           const newNames = [...tempNames];
                                                           newNames[idx] = e.target.value;
                                                           setTempNames(newNames);
                                                       }}
                                                       style={{flex: 1, padding: '4px 8px', fontSize: '0.85em', marginTop: 0}}
                                                   />
                                                   <span style={{fontSize:'0.7em', color:'#aaa'}}>.{file.name.split('.').pop()}</span>
                                               </div>
                                           ))}
                                       </div>
                                       <div style={{display:'flex', gap:10, marginTop:15}}>
                                           <button className="btn-success" style={{flex:1}} onClick={handleBatchUpload}>🚀 Carica su Drive</button>
                                           <button className="btn-outline" onClick={() => { setTempFiles([]); setTempNames([]); }}>Annulla</button>
                                       </div>
                                   </div>
                               )}
                           </div>

                           {practiceDetails?.eredi && practiceDetails.eredi.length > 0 && (
                               <div style={{marginTop: 20}}>
                                   <h4 style={{margin:'0 0 10px 0', fontSize:'0.9em', color:'#2b3a67'}}>👥 Documenti Eredi</h4>
                                   <div style={{display:'flex', flexDirection:'column', gap:12}}>
                                       {practiceDetails.eredi.map((erede) => (
                                           <div key={erede.id} className="heir-upload-card">
                                               <div style={{fontWeight:700, fontSize:'0.95em', marginBottom:10}}>{erede.nome} <small style={{fontWeight:400, color:'#666'}}>({erede.parentela})</small></div>
                                               <div className="heir-upload-grid">
                                                   <div className="upload-slot"><label>Doc. Identità</label><input type="file" multiple onChange={(e) => handleReceiptUpload(e, 'DOC_IDENTITA', erede.nome)} /></div>
                                                   <div className="upload-slot"><label>Cod. Fiscale</label><input type="file" multiple onChange={(e) => handleReceiptUpload(e, 'COD_FISCALE', erede.nome)} /></div>
                                                   <div className="upload-slot"><label>Altro</label><input type="file" multiple onChange={(e) => handleReceiptUpload(e, 'ALTRO', erede.nome)} /></div>
                                               </div>
                                           </div>
                                       ))}
                                   </div>
                               </div>
                           )}
                       </div>
                   )}
               </div>
           )}
        </div>
      )}

      {popup.show && (<div className="popup"><div className="box"><h3>{popup.title}</h3><div>{popup.msg}</div></div></div>)}
    </div>
  );
};

const container = document.getElementById('root');
if (container) createRoot(container).render(<SuccessioPro />);