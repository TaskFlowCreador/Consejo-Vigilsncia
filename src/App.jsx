import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged 
} from 'firebase/auth';
import { 
  getFirestore, collection, onSnapshot, doc, setDoc, deleteDoc, addDoc 
} from 'firebase/firestore';
import { 
  Search, Edit, Trash2, UserPlus, Image as ImageIcon, Camera, X, Check, FileText, Users, Truck, Sparkles, Copy, AlertCircle, UploadCloud, FileDown, MoreHorizontal
} from 'lucide-react';

// --- CONFIGURACIÓN INTELIGENTE (Auto-detecta el entorno) ---
const isCanvasEnv = typeof __firebase_config !== 'undefined' && __firebase_config;

const firebaseConfig = isCanvasEnv 
  ? JSON.parse(__firebase_config) 
  : {
      // ESTAS SON TUS CLAVES PARA CUANDO ESTÉ EN VERCEL
      apiKey: "AIzaSyBt5wxE37x-QDAfr1a4n_-NFsCpojuPFz8",
      authDomain: "cooperativa-colaboradores.firebaseapp.com",
      projectId: "cooperativa-colaboradores",
      storageBucket: "cooperativa-colaboradores.firebasestorage.app",
      messagingSenderId: "334165027380",
      appId: "1:334165027380:web:988b0d70687ae95d203861"
    };

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const canvasAppId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// Utilidades de rutas inteligentes para Base de Datos
const getCollectionRef = (userId, colName) => {
  return isCanvasEnv 
    ? collection(db, 'artifacts', canvasAppId, 'users', userId, colName)
    : collection(db, colName);
};

const getDocRef = (userId, colName, docId) => {
  return isCanvasEnv
    ? doc(db, 'artifacts', canvasAppId, 'users', userId, colName, docId)
    : doc(db, colName, docId);
};

// Utilidad para redimensionar fotos
const processImage = (file, isDocument = false) => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = isDocument ? 1200 : 600; 
        const MAX_HEIGHT = isDocument ? 1200 : 800;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.95)); 
      };
    };
  });
};

// --- SERVICIO GEMINI API ---
const callGeminiApi = async (prompt, isJson = false, base64Image = null) => {
  const apiKey = ""; 
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

  const parts = [{ text: prompt }];
  if (base64Image) {
    const mimeType = base64Image.match(/data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*,/)[1];
    const data = base64Image.split(',')[1];
    parts.push({ inlineData: { mimeType, data } });
  }

  const payload = {
    contents: [{ role: "user", parts }],
    generationConfig: {}
  };

  if (isJson) {
    payload.generationConfig.responseMimeType = "application/json";
    payload.generationConfig.responseSchema = {
      type: "OBJECT",
      properties: {
        nombre: { type: "STRING" },
        cedula: { type: "STRING" },
        tipoLicencia: { type: "STRING" },
        caducidadLicencia: { type: "STRING" }
      }
    };
  }

  let lastError;
  for (let attempt = 0, delay = 1000; attempt < 5; attempt++, delay *= 2) {
    try {
      const response = await fetch(url, { 
        method: "POST", 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify(payload) 
      });
      if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Generación vacía");
      return isJson ? JSON.parse(text) : text;
    } catch (error) {
      lastError = error;
      await new Promise(res => setTimeout(res, delay));
    }
  }
  throw lastError;
};

export default function App() {
  const [user, setUser] = useState(null);
  const [sociosMap, setSociosMap] = useState({});
  const [colaboradores, setColaboradores] = useState([]);
  
  // UI State
  const [searchDisco, setSearchDisco] = useState('');
  const [activeDisco, setActiveDisco] = useState(null);
  const [showGrid, setShowGrid] = useState(false); // false = pantalla de inicio (buscador), true = cuadrícula completa
  const [sidebarOpen, setSidebarOpen] = useState(false); // menú lateral en móvil
  
  // Modals & UI Feedback State
  const [isSocioModalOpen, setIsSocioModalOpen] = useState(false);
  const [isColabModalOpen, setIsColabModalOpen] = useState(false);
  const [editingSocio, setEditingSocio] = useState(null);
  const [editingColab, setEditingColab] = useState(null);
  
  const [toast, setToast] = useState(null);
  const [dialogConfig, setDialogConfig] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isExportingAll, setIsExportingAll] = useState(false);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const [exportAllProgress, setExportAllProgress] = useState({ current: 0, total: 0 });
  
  // Gemini AI States (carta de aprobación)
  const [generatingLetterId, setGeneratingLetterId] = useState(null);
  const [generatedLetter, setGeneratedLetter] = useState(null);

const DEFAULT_APROBADOR = "Cuenca Rivera Ramon Alejandro - Presidente de Vigilancia";
const TIPOS_LICENCIA = ['A', 'A1', 'B', 'C2', 'C', 'D1', 'D', 'E1', 'E', 'F', 'G'];

  // Cargar script para exportar a PNG (html2canvas) y a PDF (jsPDF)
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    script.async = true;
    document.body.appendChild(script);

    const script2 = document.createElement('script');
    script2.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    script2.async = true;
    document.body.appendChild(script2);
  }, []);

  // Auth & Firestore Listeners
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (isCanvasEnv && typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        showToast("Error conectando al servidor.", "error");
        console.error(error);
      }
    };
    initAuth();

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;

    const sociosRef = getCollectionRef(user.uid, 'socios');
    const unsubSocios = onSnapshot(sociosRef, (snapshot) => {
      const map = {};
      snapshot.forEach(doc => { map[doc.id] = doc.data(); });
      setSociosMap(map);
    }, (error) => console.error(error));

    const colabRef = getCollectionRef(user.uid, 'colaboradores');
    const unsubColab = onSnapshot(colabRef, (snapshot) => {
      const list = [];
      snapshot.forEach(doc => { list.push({ id: doc.id, ...doc.data() }); });
      list.sort((a, b) => new Date(a.fechaAprobacion) - new Date(b.fechaAprobacion));
      setColaboradores(list);
    }, (error) => console.error(error));

    return () => { unsubSocios(); unsubColab(); };
  }, [user]);

  // --- UTILS ---
  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const copyToClipboard = (text) => {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    showToast("¡Copiado al portapapeles!");
  };

  // --- IMPORTADOR DE CSV ---
  const handleCSVUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file || !user) return;

    setIsImporting(true);
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const buffer = e.target.result;
        // Excel en español suele exportar CSV con codificación Windows-1252 (ANSI).
        // Si el texto decodificado como UTF-8 sale con caracteres de reemplazo (�), reintentamos con Windows-1252.
        let text = new TextDecoder('utf-8').decode(buffer);
        if (text.includes('\uFFFD')) {
          text = new TextDecoder('windows-1252').decode(buffer);
        }

        // Detectar automáticamente el delimitador: Excel en español usa ";", el estándar internacional usa ",".
        const firstLine = text.split('\n')[0] || '';
        const delimiter = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';

        const rows = text.split('\n').map(row => row.trim().split(delimiter));
        
        let headerIndex = rows.findIndex(row => row.some(col => col.trim().toUpperCase().includes('DISCO')));
        if (headerIndex === -1) headerIndex = 0;
        
        const headers = rows[headerIndex].map(h => h.trim().toUpperCase());
        
        const idxDisco = headers.findIndex(h => h.includes('DISCO'));
        const idxNombre = headers.findIndex(h => h.includes('NOMBRE'));
        const idxCedula = headers.findIndex(h => h.includes('CEDULA') || h.includes('CÉDULA'));
        const idxFecha = headers.findIndex(h => h.includes('FECHA_INGRESO') || h.includes('INGRESO'));
        const idxPlaca = headers.findIndex(h => h.includes('PLACA'));
        const idxAnio = headers.findIndex(h => h.includes('ANIO') || h.includes('AÑO') || h.includes('ANIO_FABRICACION'));
        const idxMarca = headers.findIndex(h => h.includes('MARCA'));
        const idxTipoLic = headers.findIndex(h => h.includes('TIPO') && h.includes('LIC'));
        const idxCaduc = headers.findIndex(h => h.includes('CADUC'));

        let importedCount = 0;

        for (let i = headerIndex + 1; i < rows.length; i++) {
          const cols = rows[i];
          if (!cols || !cols[idxDisco]) continue;

          const discoNum = parseInt(cols[idxDisco].trim());
          if (isNaN(discoNum) || discoNum < 1 || discoNum > 61) continue;

          // Solo se guardan las columnas que existen Y traen valor en esta fila.
          // Con { merge: true } un CSV nunca borra datos que ya estaban (p. ej. la licencia
          // cargada a mano) ni toca los discos que no aparecen en el archivo.
          const leer = (idx) => (idx !== -1 ? (cols[idx] || '').trim() : '');
          const socioData = { disco: discoNum };
          [
            ['nombre', idxNombre], ['cedula', idxCedula], ['fechaIngreso', idxFecha],
            ['placa', idxPlaca], ['anio', idxAnio], ['marca', idxMarca],
            ['tipoLicencia', idxTipoLic], ['caducidadLicencia', idxCaduc],
          ].forEach(([campo, idx]) => {
            const valor = leer(idx);
            if (valor) socioData[campo] = valor;
          });

          const socioDocRef = getDocRef(user.uid, 'socios', discoNum.toString());
          await setDoc(socioDocRef, socioData, { merge: true });
          importedCount++;
        }

        showToast(`Listo: se actualizaron ${importedCount} socio${importedCount !== 1 ? 's' : ''}. El resto no se modificó.`);
      } catch (error) {
        console.error(error);
        showToast(`Error al procesar el CSV: ${error.code || error.message || error}`, "error");
      } finally {
        setIsImporting(false);
        event.target.value = '';
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // --- GEMINI ACTIONS ---

  const handleGenerateWelcomeLetter = async (colab, socio) => {
    setGeneratingLetterId(colab.id);
    try {
      const prompt = `Escribe una carta formal de bienvenida de la "Cooperativa de Transporte" para el nuevo chofer colaborador.
      Datos del Chofer: ${colab.nombre} (Cédula: ${colab.cedula}).
      Datos de la Unidad: Vehículo placa ${colab.placaVehiculo}, Disco #${socio.disco}, propiedad del socio ${socio.nombre}.
      Aprobación: Esta integración fue aprobada formalmente por el ${colab.aprobadoPor} el día ${colab.fechaAprobacion}.
      
      Instrucciones: Escribe una carta redactada formalmente, en idioma español, de máximo 3 párrafos.`;
      
      const letterText = await callGeminiApi(prompt, false);
      setGeneratedLetter({ title: `Carta para ${colab.nombre}`, content: letterText });
    } catch (error) {
      showToast("Error al generar la carta con IA.", "error");
    } finally {
      setGeneratingLetterId(null);
    }
  };

  // --- STANDARD ACTIONS ---
  // Calcula si una licencia está vigente, por vencer (30 días o menos) o vencida
  const getLicenciaStatus = (fechaStr) => {
    if (!fechaStr) return null;
    const fechaVence = new Date(`${fechaStr}T00:00:00`);
    if (isNaN(fechaVence.getTime())) return null;
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const diffDias = Math.ceil((fechaVence - hoy) / (1000 * 60 * 60 * 24));
    if (diffDias < 0) return 'vencida';
    if (diffDias <= 30) return 'por_vencer';
    return 'vigente';
  };

  // --- BUSCADOR UNIFICADO: disco, placa o nombre/apellido ---
  // Normaliza texto: minúsculas, sin tildes, sin guiones/espacios extra
  const normalizar = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  // Para placas se quitan guiones y espacios: "MAA-1123" == "maa 1123" == "MAA1123"
  const normalizarPlaca = (s) => (s || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');

  const buscarSocios = (texto) => {
    const q = texto.trim();
    if (!q) return [];

    // Solo números 1-61 => es un número de disco exacto
    if (/^\d+$/.test(q)) {
      const n = parseInt(q, 10);
      if (n >= 1 && n <= 61) return [{ disco: n, motivo: 'Disco', socio: sociosMap[n] || null }];
    }

    const resultados = new Map(); // disco -> { disco, motivo, socio }
    const placaQ = normalizarPlaca(q);
    const palabras = normalizar(q).split(/\s+/).filter(Boolean);

    // 1) Socios: por placa o por nombre (todas las palabras deben aparecer, en cualquier orden)
    Object.entries(sociosMap).forEach(([id, socio]) => {
      const disco = Number(id);
      if (placaQ.length >= 2 && normalizarPlaca(socio.placa).includes(placaQ)) {
        resultados.set(disco, { disco, motivo: 'Placa', socio });
        return;
      }
      const nombre = normalizar(socio.nombre);
      if (palabras.length > 0 && palabras.every(p => nombre.includes(p))) {
        resultados.set(disco, { disco, motivo: 'Socio', socio });
      }
    });

    // 2) Colaboradores: por nombre, cédula o placa asignada => se muestra el disco al que pertenecen
    colaboradores.forEach(c => {
      const disco = Number(c.socioId);
      if (!disco || resultados.has(disco)) return;
      const nombre = normalizar(c.nombre);
      const coincideNombre = palabras.length > 0 && palabras.every(p => nombre.includes(p));
      const coincideCedula = q.length >= 4 && (c.cedula || '').replace(/\D/g, '').includes(q.replace(/\D/g, '')) && /\d/.test(q);
      const coincidePlaca = placaQ.length >= 3 && normalizarPlaca(c.placaVehiculo).includes(placaQ);
      if (coincideNombre || coincideCedula || coincidePlaca) {
        resultados.set(disco, { disco, motivo: `Colaborador: ${c.nombre}`, socio: sociosMap[disco] || null });
      }
    });

    return Array.from(resultados.values()).sort((a, b) => a.disco - b.disco);
  };

  const abrirDisco = (disco) => {
    setActiveDisco(disco);
    setSearchDisco('');
  };

  const handleSearch = (e) => {
    e.preventDefault();
    const q = searchDisco.trim();
    if (!q) return;
    const resultados = buscarSocios(q);
    if (resultados.length === 1) {
      abrirDisco(resultados[0].disco);
    } else if (resultados.length === 0) {
      setDialogConfig({ type: 'alert', message: `No se encontró ningún socio ni colaborador con "${q}". Puedes buscar por número de disco (1 al 61), placa o nombre y apellido.` });
    }
    // Si hay varios resultados, quedan visibles en la lista debajo del buscador para elegir.
  };

  const handleSaveSocio = async (socioData) => {
    if (!user) return;
    const socioDocRef = getDocRef(user.uid, 'socios', socioData.disco.toString());
    await setDoc(socioDocRef, socioData);
    setIsSocioModalOpen(false);
    showToast("Datos del socio actualizados correctamente.");
  };

  const handleSaveColaborador = async (colabData) => {
    if (!user) return;
    if (colabData.id) {
      const colabDocRef = getDocRef(user.uid, 'colaboradores', colabData.id);
      await setDoc(colabDocRef, colabData);
    } else {
      const colabCollRef = getCollectionRef(user.uid, 'colaboradores');
      await addDoc(colabCollRef, colabData);
    }
    setIsColabModalOpen(false);
    showToast("Colaborador registrado correctamente.");
  };

  const handleDeleteColaborador = (id) => {
    setDialogConfig({
      type: 'confirm',
      message: "¿Está seguro de eliminar permanentemente a este colaborador?",
      onConfirm: async () => {
        const colabDocRef = getDocRef(user.uid, 'colaboradores', id);
        await deleteDoc(colabDocRef);
        showToast("Colaborador eliminado.");
      }
    });
  };

  // --- EXPORTAR A IMAGEN (PNG) ---
  const exportToImage = () => {
    if (!window.html2canvas) {
      setDialogConfig({ type: 'alert', message: "La herramienta de captura está cargando, intente en unos segundos." });
      return;
    }

    setIsExporting(true);

    setTimeout(() => {
      const element = document.getElementById('ficha-export');
      
      window.html2canvas(element, {
        scale: 2, 
        useCORS: true,
        backgroundColor: "#ffffff",
        logging: false
      }).then(canvas => {
        const imgData = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = `Ficha_Socio_Disco_${activeDisco}.png`;
        link.href = imgData;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        setIsExporting(false);
        showToast("Imagen descargada correctamente.");
      }).catch(err => {
        console.error("Error capturando imagen:", err);
        setIsExporting(false);
        showToast("Hubo un error al generar la imagen.", "error");
      });
    }, 400); 
  };

  // --- EXPORTAR RESPALDO COMPLETO (PDF, una página por socio) ---
  const capturarFichaComoImagen = () => {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const element = document.getElementById('ficha-export');
        if (!element) { reject(new Error('No se encontró la ficha en pantalla.')); return; }
        window.html2canvas(element, { scale: 2, useCORS: true, backgroundColor: "#ffffff", logging: false })
          .then(canvas => {
            resolve({
              imgData: canvas.toDataURL('image/jpeg', 0.92),
              width: element.offsetWidth,
              height: element.offsetHeight,
            });
          })
          .catch(reject);
      }, 350);
    });
  };

  const exportAllToPDF = async (scope = 'conColaboradores') => {
    if (!window.html2canvas || !window.jspdf) {
      setDialogConfig({ type: 'alert', message: "Las herramientas de exportación están cargando, intenta de nuevo en unos segundos." });
      return;
    }
    let discosConSocio = Object.keys(sociosMap).map(Number).sort((a, b) => a - b);
    if (scope === 'conColaboradores') {
      discosConSocio = discosConSocio.filter(disco => colaboradores.some(c => c.socioId === disco.toString()));
    }
    if (discosConSocio.length === 0) {
      setDialogConfig({ type: 'alert', message: scope === 'conColaboradores' ? "Todavía no hay socios con colaboradores registrados para exportar." : "Todavía no hay socios registrados para exportar." });
      return;
    }

    setIsExportingAll(true);
    setIsExporting(true); // oculta los botones de acción dentro de cada ficha durante la captura
    setExportAllProgress({ current: 0, total: discosConSocio.length });

    try {
      const { jsPDF } = window.jspdf;
      let pdf = null;

      for (let i = 0; i < discosConSocio.length; i++) {
        const disco = discosConSocio[i];
        setActiveDisco(disco);
        setExportAllProgress({ current: i + 1, total: discosConSocio.length });

        const { imgData, width, height } = await capturarFichaComoImagen();
        const orientation = width > height ? 'landscape' : 'portrait';

        if (!pdf) {
          pdf = new jsPDF({ unit: 'px', format: [width, height], orientation });
        } else {
          pdf.addPage([width, height], orientation);
        }
        pdf.addImage(imgData, 'JPEG', 0, 0, width, height);
      }

      const sufijo = scope === 'conColaboradores' ? 'ConColaboradores' : 'Todos';
      pdf.save(`Respaldo_Cooperativa_N14_${sufijo}_${new Date().toISOString().slice(0, 10)}.pdf`);
      showToast(`Respaldo generado: ${discosConSocio.length} socios en PDF.`);
    } catch (err) {
      console.error("Error generando respaldo PDF:", err);
      showToast("Hubo un error generando el respaldo en PDF.", "error");
    } finally {
      setIsExportingAll(false);
      setIsExporting(false);
      setExportAllProgress({ current: 0, total: 0 });
      setActiveDisco(null);
      setShowGrid(true);
    }
  };

  // --- RENDERIZADO PRINCIPAL ---
  if (!user) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500 font-sans">Conectando al sistema seguro...</div>;
  }

  // Pantalla de inicio: buscador central + resumen rápido
  const renderInicio = () => {
    const totalSocios = Object.keys(sociosMap).length;
    const totalColabs = colaboradores.length;
    const fechasLic = [
      ...Object.values(sociosMap).map(s => s.caducidadLicencia),
      ...colaboradores.map(c => c.caducidadLicencia),
    ];
    const licPorRevisar = fechasLic
      .map(getLicenciaStatus)
      .filter(s => s === 'vencida' || s === 'por_vencer').length;

    const stats = [
      { label: 'Socios registrados', value: `${totalSocios}/61`, icon: Truck, tone: 'text-blue-600 bg-blue-50' },
      { label: 'Colaboradores', value: totalColabs, icon: Users, tone: 'text-green-600 bg-green-50' },
      { label: 'Licencias por revisar', value: licPorRevisar, icon: AlertCircle, tone: licPorRevisar > 0 ? 'text-amber-600 bg-amber-50' : 'text-slate-400 bg-slate-100' },
    ];

    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 md:pt-16 flex flex-col items-center text-center">
        <div className="bg-blue-600 p-4 rounded-2xl shadow-lg shadow-blue-200 mb-5">
          <Truck size={34} className="text-white" />
        </div>
        <h2 className="text-2xl md:text-4xl font-bold text-slate-800 mb-2 tracking-tight">Buscar Socio</h2>
        <p className="text-slate-500 mb-7 text-sm sm:text-base max-w-md">Escribe el número de disco, la placa o el nombre y apellido.</p>

        <form onSubmit={handleSearch} className="w-full">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-4 sm:pl-5 flex items-center pointer-events-none">
              <Search className="h-5 w-5 sm:h-6 sm:w-6 text-slate-400" />
            </div>
            <input
              autoFocus
              type="text"
              autoComplete="off"
              enterKeyHint="search"
              className="block w-full pl-12 sm:pl-14 pr-4 py-4 sm:py-5 border border-slate-200 rounded-2xl bg-white text-slate-900 placeholder-slate-400 shadow-md focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-400 transition-all text-lg sm:text-xl"
              placeholder="Disco, placa o nombre..."
              value={searchDisco}
              onChange={(e) => setSearchDisco(e.target.value)}
            />
          </div>
        </form>

        {searchDisco.trim().length >= 2 && (() => {
          const resultados = buscarSocios(searchDisco);
          if (resultados.length === 0) {
            return <p className="w-full mt-4 text-sm text-slate-400">Sin coincidencias para "{searchDisco.trim()}".</p>;
          }
          return (
            <div className="w-full mt-4 bg-white border border-slate-200 rounded-2xl shadow-md overflow-hidden text-left max-h-80 sm:max-h-96 overflow-y-auto">
              {resultados.slice(0, 20).map(r => (
                <button
                  key={r.disco}
                  type="button"
                  onClick={() => abrirDisco(r.disco)}
                  className="w-full flex items-center gap-3 sm:gap-4 px-4 sm:px-5 py-3 border-b border-slate-100 last:border-b-0 hover:bg-blue-50 active:bg-blue-50 transition-colors text-left"
                >
                  <span className="bg-blue-600 text-white font-bold text-sm rounded-lg w-12 sm:w-14 py-1.5 text-center shrink-0">
                    {r.disco}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-semibold text-slate-800 truncate">{r.socio ? r.socio.nombre : 'Vacante (sin socio registrado)'}</span>
                    <span className="block text-xs text-slate-500 truncate">
                      {r.socio?.placa ? `Placa ${r.socio.placa} · ` : ''}{r.motivo}
                    </span>
                  </span>
                </button>
              ))}
              {resultados.length > 20 && (
                <p className="px-5 py-2 text-xs text-slate-400 bg-slate-50">Mostrando 20 de {resultados.length}. Escribe más para afinar.</p>
              )}
            </div>
          );
        })()}

        <div className="w-full grid grid-cols-3 gap-2 sm:gap-4 mt-8 sm:mt-10">
          {stats.map(s => (
            <div key={s.label} className="bg-white border border-slate-200 rounded-2xl p-3 sm:p-5 shadow-sm flex flex-col items-center gap-1.5">
              <span className={`p-2 rounded-xl ${s.tone}`}><s.icon size={18} /></span>
              <span className="text-xl sm:text-3xl font-bold text-slate-800 leading-none">{s.value}</span>
              <span className="text-[11px] sm:text-sm text-slate-500 leading-tight">{s.label}</span>
            </div>
          ))}
        </div>

        <button
          onClick={() => setShowGrid(true)}
          className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-5 py-2.5 rounded-xl transition-colors"
        >
          <Users size={16} /> Ver todos los discos
        </button>
      </div>
    );
  };

  const renderGrid = () => {
    const discos = Array.from({ length: 61 }, (_, i) => i + 1);
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 md:py-4">
        <div className="mb-5 bg-white p-4 sm:p-5 rounded-2xl shadow-sm border border-slate-200">
          <button
            onClick={() => setShowGrid(false)}
            className="text-slate-400 hover:text-slate-700 text-sm font-medium mb-1 flex items-center gap-1"
          >
            ← Volver al buscador
          </button>
          <h2 className="text-lg sm:text-xl font-bold text-slate-800">Directorio de Unidades (Discos)</h2>
          <p className="text-sm text-slate-500">Selecciona un disco para ver al socio y sus colaboradores.</p>
          <div className="flex flex-wrap gap-x-5 gap-y-1.5 mt-3 text-xs text-slate-500">
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-green-100 border border-green-300"></span> Con colaboradores</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-amber-100 border border-amber-300"></span> Licencia vencida</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-white border border-slate-300"></span> Sin colaboradores</span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3 sm:gap-4">
          {discos.map(disco => {
            const socio = sociosMap[disco];
            const hasSocio = !!socio;
            const numColabs = colaboradores.filter(c => c.socioId === disco.toString()).length;
            const hasColaboradores = numColabs > 0;
            const licStatus = socio ? getLicenciaStatus(socio.caducidadLicencia) : null;
            const licVencida = licStatus === 'vencida';
            const licPorVencer = licStatus === 'por_vencer';

            // Prioridad de color de fondo: verde (tiene colaboradores) > amarillo (sin colaboradores pero licencia vencida) > blanco.
            const colorClass = hasColaboradores
              ? 'border-green-200 bg-green-50 text-green-900 hover:bg-green-100 hover:shadow-lg hover:shadow-green-100'
              : licVencida
              ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 hover:shadow-lg hover:shadow-amber-100'
              : hasSocio
              ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:shadow-md'
              : 'border-slate-100 bg-white text-slate-300 hover:border-slate-200 hover:shadow-md';

            return (
              <button
                key={disco}
                onClick={() => setActiveDisco(disco)}
                className={`relative h-32 sm:h-36 px-2 py-3 rounded-2xl border transition-all duration-200 flex flex-col items-center justify-center gap-1 hover:-translate-y-0.5 active:scale-[0.98] ${colorClass}`}
              >
                {/* Aviso de licencia, visible siempre (incluso en discos verdes) para no ocultar la alerta */}
                {(licVencida || licPorVencer) && (
                  <span
                    className={`absolute -top-2 -right-2 w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold shadow ${licVencida ? 'bg-amber-500 text-white' : 'bg-amber-100 text-amber-700 border border-amber-300'}`}
                    title={licVencida ? 'Licencia vencida' : 'Licencia por vencer'}
                  >⚠</span>
                )}
                <span className="text-[11px] font-semibold tracking-wide opacity-60">DISCO</span>
                <span className="text-3xl font-bold leading-none">{disco}</span>
                <span className="text-xs text-center truncate w-full px-1 font-medium">
                  {hasSocio ? socio.nombre.split(' ').slice(0,2).join(' ') : 'Vacante'}
                </span>
                <span className="h-4 text-[10px] font-bold text-green-700 flex items-center gap-1">
                  {hasColaboradores && <><Users size={11}/> {numColabs} colaborador{numColabs !== 1 ? 'es' : ''}</>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const renderSocioView = () => {
    const socio = sociosMap[activeDisco];
    const socioColabs = colaboradores.filter(c => c.socioId === activeDisco.toString());

    return (
      <div className="p-4 md:p-8 max-w-7xl mx-auto animate-fadeIn flex flex-col items-center">
        <div className="w-full max-w-5xl mb-4 flex justify-between gap-3">
          <button 
            onClick={() => setActiveDisco(null)}
            className="text-slate-500 hover:text-slate-800 flex items-center text-sm font-medium transition-colors bg-white px-4 py-2 rounded-lg shadow-sm border border-slate-200 w-max"
          >
            ← Volver
          </button>

          {!isExporting && socio && (
            <button 
              onClick={exportToImage}
              className="flex items-center space-x-2 bg-blue-600 text-white hover:bg-blue-700 px-4 sm:px-6 py-2 rounded-lg transition-all text-sm font-bold shadow-md"
            >
              <ImageIcon size={20} />
              <span className="hidden sm:inline">Descargar Ficha (Imagen)</span><span className="sm:hidden">Descargar</span>
            </button>
          )}
        </div>

        <div id="ficha-export" className="bg-white rounded-xl shadow-xl border border-slate-300 overflow-hidden w-full max-w-5xl">
          
          <div className="bg-slate-900 px-5 py-6 sm:px-8 sm:py-8 text-white flex flex-col justify-center items-center border-b-4 border-blue-600 text-center">
            <h2 className="text-xl sm:text-2xl md:text-3xl font-extrabold uppercase tracking-wide sm:tracking-widest text-white">
              Registro Colaboradores
            </h2>
            <h3 className="text-sm sm:text-xl md:text-2xl font-bold text-blue-300 mt-2 uppercase tracking-wide">
              Consejo de Vigilancia 2026-2027
            </h3>
          </div>
          
          <div className="p-4 sm:p-8 md:p-10">
            <div className="mb-8 sm:mb-12">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end border-b-2 border-slate-200 pb-4 mb-6 gap-4">
                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                  <h3 className="text-lg sm:text-2xl font-bold text-slate-800 flex items-center gap-3">
                    <Users className="text-blue-600" size={28}/> Datos del Socio Propietario
                  </h3>
                  <div className="bg-blue-600 text-white text-lg font-bold px-5 py-2 rounded-lg shadow-sm inline-block whitespace-nowrap">
                    SOCIO DISCO {activeDisco}
                  </div>
                </div>

                {!isExporting && (
                  <button 
                    onClick={() => {
                      setEditingSocio(socio || { disco: activeDisco, nombre: '', cedula: '', fechaIngreso: '', placa: '', anio: '', marca: '', tipoLicencia: '', caducidadLicencia: '' });
                      setIsSocioModalOpen(true);
                    }}
                    className="text-blue-600 hover:text-blue-800 text-sm font-bold flex items-center gap-1 transition-colors bg-blue-50 px-3 py-1.5 rounded-md shrink-0"
                  >
                    <Edit size={16} /> {socio ? 'Editar Datos' : 'Registrar Socio'}
                  </button>
                )}
              </div>

              {socio ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8 bg-slate-50 p-4 sm:p-8 rounded-xl border border-slate-200">
                  <div className="space-y-6">
                    <div>
                      <p className="text-sm text-slate-500 font-bold uppercase tracking-wider">Nombres Completos</p>
                      <p className="font-bold text-slate-900 text-xl">{socio.nombre}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-6">
                      <div>
                        <p className="text-sm text-slate-500 font-bold uppercase tracking-wider">Cédula</p>
                        <p className="font-bold text-slate-900 text-lg">{socio.cedula || '-'}</p>
                      </div>
                      <div>
                        <p className="text-sm text-slate-500 font-bold uppercase tracking-wider">Fecha de Ingreso</p>
                        <p className="font-bold text-slate-900 text-lg">{socio.fechaIngreso || '-'}</p>
                      </div>
                    </div>
                    {(() => {
                      const socioLicStatus = getLicenciaStatus(socio.caducidadLicencia);
                      const licBoxClass = socioLicStatus === 'vencida'
                        ? 'bg-red-50 border-red-200 text-red-800'
                        : socioLicStatus === 'por_vencer'
                        ? 'bg-amber-50 border-amber-200 text-amber-800'
                        : 'bg-slate-100 border-slate-200 text-slate-700';
                      return (
                        <div className={`grid grid-cols-2 gap-6 p-4 rounded-lg border ${licBoxClass}`}>
                          <div>
                            <p className="text-sm font-bold uppercase tracking-wider opacity-70">Licencia de Conducir</p>
                            <p className="font-bold text-lg">{socio.tipoLicencia || '-'}</p>
                          </div>
                          <div>
                            <p className="text-sm font-bold uppercase tracking-wider opacity-70">Caducidad</p>
                            <p className="font-bold text-lg">
                              <span className="whitespace-nowrap">{socio.caducidadLicencia || '-'}</span>
                              {socioLicStatus === 'vencida' && <span className="block sm:inline sm:ml-2 text-xs font-bold uppercase">⚠ Vencida</span>}
                              {socioLicStatus === 'por_vencer' && <span className="block sm:inline sm:ml-2 text-xs font-bold uppercase">⚠ Por vencer</span>}
                            </p>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                  
                  <div className="border-t-2 lg:border-t-0 lg:border-l-2 border-slate-200 pt-6 lg:pt-0 lg:pl-8 space-y-6">
                    <p className="text-sm text-blue-700 font-bold uppercase tracking-wider flex items-center gap-2">
                      <Truck size={18}/> Datos del Vehículo
                    </p>
                    <div className="grid grid-cols-2 gap-6">
                      <div>
                        <p className="text-sm text-slate-500 font-bold uppercase tracking-wider">Placa</p>
                        <p className="font-bold text-slate-900 text-xl">{socio.placa || '-'}</p>
                      </div>
                      <div>
                        <p className="text-sm text-slate-500 font-bold uppercase tracking-wider">Año</p>
                        <p className="font-bold text-slate-900 text-xl">{socio.anio || '-'}</p>
                      </div>
                      <div className="col-span-2">
                        <p className="text-sm text-slate-500 font-bold uppercase tracking-wider">Marca / Modelo</p>
                        <p className="font-bold text-slate-900 text-lg">{socio.marca || '-'}</p>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center py-16 bg-slate-50 rounded-xl border-2 border-dashed border-slate-300">
                  <p className="mb-6 text-slate-600 text-lg">Aún no se han registrado los datos del socio para este disco.</p>
                  {!isExporting && (
                    <button 
                      onClick={() => {
                        setEditingSocio({ disco: activeDisco, nombre: '', cedula: '', fechaIngreso: '', placa: '', anio: '', marca: '', tipoLicencia: '', caducidadLicencia: '' });
                        setIsSocioModalOpen(true);
                      }}
                      className="bg-blue-600 text-white px-8 py-3 rounded-lg font-bold hover:bg-blue-700 shadow-md text-lg"
                    >
                      Registrar Socio
                    </button>
                  )}
                </div>
              )}
            </div>

            {socio && (
              <div>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end border-b-2 border-slate-200 pb-4 mb-6 gap-4">
                  <h3 className="text-lg sm:text-2xl font-bold text-slate-800 flex items-center gap-3">
                    <FileText className="text-blue-600" size={28}/> Lista de Colaboradores Aprobados ({socioColabs.length})
                  </h3>
                  
                  {!isExporting && (
                    <button 
                      onClick={() => {
                        setEditingColab({
                          socioId: activeDisco.toString(),
                          nombre: '', cedula: '', tipoLicencia: '', caducidadLicencia: '', 
                          placaVehiculo: socio.placa || '', 
                          aprobadoPor: DEFAULT_APROBADOR,
                          fechaAprobacion: new Date().toISOString().split('T')[0],
                          fotoBase64: ''
                        });
                        setIsColabModalOpen(true);
                      }}
                      className="flex items-center space-x-2 bg-slate-800 hover:bg-slate-700 text-white px-5 py-2.5 rounded-lg font-bold transition-colors shadow-md shrink-0"
                    >
                      <UserPlus size={18} />
                      <span>Sumar Colaborador</span>
                    </button>
                  )}
                </div>

                {socioColabs.length === 0 ? (
                  <div className="text-center py-12 bg-slate-50 rounded-xl border border-slate-200">
                    <p className="text-slate-500 text-lg">La lista de colaboradores está vacía.</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-6">
                    {socioColabs.map((colab, index) => {
                      const licStatus = getLicenciaStatus(colab.caducidadLicencia);
                      const licClass = licStatus === 'vencida'
                        ? 'bg-red-50 text-red-800 border border-red-200'
                        : licStatus === 'por_vencer'
                        ? 'bg-amber-50 text-amber-800 border border-amber-200'
                        : '';
                      return (
                      <div key={colab.id} className="bg-white border border-slate-300 rounded-xl shadow-sm flex flex-col md:flex-row hover:border-blue-300 transition-colors overflow-hidden">
                        
                        <div className="p-6 flex flex-col sm:flex-row flex-1 gap-6">
                          <div className="w-32 h-40 sm:w-36 sm:h-48 mx-auto sm:mx-0 flex-shrink-0 bg-slate-100 rounded-lg border border-slate-300 flex items-center justify-center overflow-hidden relative shadow-inner">
                            {colab.fotoBase64 ? (
                              <img src={colab.fotoBase64} alt={colab.nombre} className="w-full h-full object-cover" />
                            ) : (
                              <div className="text-center">
                                <Camera className="text-slate-400 mx-auto" size={40} />
                                <span className="text-xs text-slate-500 mt-2 block font-medium">Sin Foto</span>
                              </div>
                            )}
                          </div>
                          
                          <div className="flex-grow flex flex-col justify-center text-center sm:text-left">
                            <div className="text-sm font-bold text-blue-600 mb-2 uppercase tracking-wider">COLABORADOR #{index + 1}</div>
                            <h4 className="font-bold text-slate-900 leading-tight text-xl sm:text-2xl mb-4 break-words">{colab.nombre}</h4>
                            
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-6 text-base text-slate-700">
                              <p><span className="font-bold text-slate-900">Cédula:</span> {colab.cedula}</p>
                              <p className={`rounded-lg px-2 py-1 -mx-2 ${licClass}`}>
                                <span className="font-bold text-slate-900">Licencia:</span> {colab.tipoLicencia} (Vence: {colab.caducidadLicencia})
                                {licStatus === 'vencida' && <span className="block sm:inline sm:ml-2 text-xs font-bold uppercase">⚠ Vencida</span>}
                                {licStatus === 'por_vencer' && <span className="block sm:inline sm:ml-2 text-xs font-bold uppercase">⚠ Por vencer</span>}
                              </p>
                            </div>
                            
                            <div className="mt-4 pt-4 border-t border-slate-200">
                              <p className="text-base text-slate-800"><span className="font-bold text-slate-900">Aprobado por:</span> {colab.aprobadoPor}</p>
                              <p className="text-base text-slate-800 mt-1"><span className="font-bold text-slate-900 text-blue-700">Fecha de Aprobación:</span> <span className="font-semibold">{colab.fechaAprobacion}</span></p>
                            </div>
                          </div>
                        </div>
                        
                        {!isExporting && (
                          <div className="bg-slate-50 md:w-48 px-4 py-4 md:border-l border-t md:border-t-0 border-slate-200 flex flex-row md:flex-col justify-center gap-3">
                             <button 
                              onClick={() => handleGenerateWelcomeLetter(colab, socio)}
                              disabled={generatingLetterId === colab.id}
                              className="flex-1 flex items-center justify-center space-x-2 px-4 py-2 bg-white border border-purple-200 text-purple-700 hover:bg-purple-50 hover:border-purple-300 rounded-lg text-sm font-bold transition-colors shadow-sm"
                            >
                              <Sparkles size={16} /> <span className="hidden md:inline">Carta IA</span>
                            </button>
                            <button 
                              onClick={() => { setEditingColab(colab); setIsColabModalOpen(true); }}
                              className="flex-1 flex items-center justify-center space-x-2 px-4 py-2 bg-white border border-blue-200 text-blue-700 hover:bg-blue-50 hover:border-blue-300 rounded-lg text-sm font-bold transition-colors shadow-sm"
                            >
                              <Edit size={16} /> <span className="hidden md:inline">Editar</span>
                            </button>
                            <button 
                              onClick={() => handleDeleteColaborador(colab.id)}
                              className="flex-1 flex items-center justify-center space-x-2 px-4 py-2 bg-white border border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300 rounded-lg text-sm font-bold transition-colors shadow-sm"
                            >
                              <Trash2 size={16} /> <span className="hidden md:inline">Eliminar</span>
                            </button>
                          </div>
                        )}
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Navegación reutilizable para la barra lateral (desktop) y el menú móvil
  const navItems = [
    { key: 'inicio', label: 'Inicio', icon: Search, onClick: () => { setActiveDisco(null); setShowGrid(false); setSidebarOpen(false); } },
    { key: 'discos', label: 'Ver todos los discos', icon: Users, onClick: () => { setActiveDisco(null); setShowGrid(true); setSidebarOpen(false); } },
    { key: 'importar', label: isImporting ? 'Importando...' : 'Importar datos (CSV)', icon: UploadCloud, onClick: () => { document.getElementById('csv-upload-sidebar').click(); setSidebarOpen(false); } },
    { key: 'exportar', label: 'Exportar respaldo (PDF)', icon: FileDown, onClick: () => { setSidebarOpen(false); setExportConfirmOpen(true); } },
  ];
  const currentView = activeDisco !== null ? 'ficha' : (showGrid ? 'discos' : 'inicio');

  return (
    <div className="min-h-screen bg-slate-100 font-sans md:flex">
      <input type="file" id="csv-upload-sidebar" accept=".csv" className="hidden" onChange={handleCSVUpload} />

      {/* --- BARRA LATERAL (desktop) --- */}
      <aside className="hidden md:flex md:flex-col md:w-64 md:shrink-0 bg-slate-900 text-white min-h-screen sticky top-0">
        <div className="flex items-center gap-3 px-6 h-20 border-b border-slate-800">
          <div className="bg-blue-600 p-2.5 rounded-xl">
            <Truck size={24} className="text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold leading-tight">Cooperativa N°14</h1>
            <p className="text-blue-300 text-xs font-medium">Consejo de Vigilancia 2026-2027</p>
          </div>
        </div>
        <nav className="flex-1 px-3 py-6 space-y-1">
          {navItems.map(item => (
            <button
              key={item.key}
              onClick={item.onClick}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-colors
                ${currentView === item.key ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}
            >
              <item.icon size={18} />
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* --- ENCABEZADO (solo celular) --- */}
      <header
        className="md:hidden bg-slate-900 shadow-lg sticky top-0 z-20 border-b-4 border-blue-600"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="px-4 h-14 flex items-center">
          <button onClick={() => { setActiveDisco(null); setShowGrid(false); }} className="flex items-center gap-3 text-white">
            <div className="bg-blue-600 p-2 rounded-lg">
              <Truck size={18} className="text-white" />
            </div>
            <span className="flex flex-col items-start leading-tight">
              <span className="font-bold text-sm">Cooperativa N°14</span>
              <span className="text-[11px] text-blue-300 font-medium">Consejo de Vigilancia 2026-2027</span>
            </span>
          </button>
        </div>
      </header>

      {/* --- BARRA INFERIOR (solo celular): acceso con el pulgar --- */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-slate-900 border-t border-slate-800 grid grid-cols-3"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {navItems.filter(i => i.key === 'inicio' || i.key === 'discos').map(item => (
          <button
            key={item.key}
            onClick={item.onClick}
            className={`flex flex-col items-center justify-center gap-1 py-2.5 text-[11px] font-semibold transition-colors
              ${currentView === item.key ? 'text-white' : 'text-slate-400'}`}
          >
            <span className={`px-4 py-1 rounded-full ${currentView === item.key ? 'bg-blue-600' : ''}`}>
              <item.icon size={20} />
            </span>
            {item.key === 'inicio' ? 'Buscar' : 'Discos'}
          </button>
        ))}
        <button
          onClick={() => setSidebarOpen(true)}
          className="flex flex-col items-center justify-center gap-1 py-2.5 text-[11px] font-semibold text-slate-400"
        >
          <span className="px-4 py-1"><MoreHorizontal size={20} /></span>
          Más
        </button>
      </nav>

      {/* --- HOJA "MÁS" (celular): importar y respaldo --- */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-slate-900/60" onClick={() => setSidebarOpen(false)}></div>
          <div
            className="relative w-full bg-white rounded-t-3xl p-5 animate-slideUp"
            style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
          >
            <div className="flex justify-between items-center mb-4">
              <span className="font-bold text-slate-800 text-lg">Datos y respaldo</span>
              <button onClick={() => setSidebarOpen(false)} className="text-slate-400 p-2 -mr-2" aria-label="Cerrar"><X size={22} /></button>
            </div>
            <div className="space-y-2">
              {navItems.filter(i => i.key === 'importar' || i.key === 'exportar').map(item => (
                <button
                  key={item.key}
                  onClick={item.onClick}
                  className="w-full flex items-center gap-3 px-4 py-4 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 font-semibold text-left"
                >
                  <span className="bg-blue-100 text-blue-600 p-2 rounded-lg"><item.icon size={20} /></span>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 min-w-0">

      {exportConfirmOpen && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-[60] animate-fadeIn">
          <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full">
            <div className="flex items-center gap-3 mb-4">
              <div className="bg-blue-100 text-blue-600 p-3 rounded-xl"><FileDown size={24} /></div>
              <h3 className="text-lg font-bold text-slate-800">Exportar respaldo en PDF</h3>
            </div>
            <p className="text-sm text-slate-500 mb-6">
              Esto puede tardar varios minutos según cuántos socios incluyas. Elige qué quieres descargar:
            </p>
            <div className="space-y-3">
              <button
                onClick={() => { setExportConfirmOpen(false); exportAllToPDF('conColaboradores'); }}
                className="w-full flex items-center justify-between gap-3 bg-blue-600 hover:bg-blue-700 text-white px-5 py-4 rounded-xl font-bold text-left transition-colors"
              >
                <span>Solo socios <u>con</u> colaboradores</span>
                <span className="bg-white/20 text-xs font-semibold px-2 py-1 rounded-full shrink-0">
                  {Object.keys(sociosMap).filter(disco => colaboradores.some(c => c.socioId === disco.toString())).length} socios
                </span>
              </button>
              <button
                onClick={() => { setExportConfirmOpen(false); exportAllToPDF('todos'); }}
                className="w-full flex items-center justify-between gap-3 bg-slate-100 hover:bg-slate-200 text-slate-800 px-5 py-4 rounded-xl font-bold text-left transition-colors"
              >
                <span>Todos los socios registrados</span>
                <span className="bg-slate-300 text-slate-700 text-xs font-semibold px-2 py-1 rounded-full shrink-0">
                  {Object.keys(sociosMap).length} socios
                </span>
              </button>
            </div>
            <button onClick={() => setExportConfirmOpen(false)} className="w-full mt-4 text-slate-500 hover:text-slate-700 font-medium py-2">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {isExportingAll && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4 z-[60] animate-fadeIn">
          <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-sm w-full text-center">
            <FileDown className="mx-auto text-blue-600 mb-4 animate-pulse" size={40} />
            <h3 className="text-lg font-bold text-slate-800 mb-2">Generando respaldo en PDF...</h3>
            <p className="text-sm text-slate-500 mb-4">Socio {exportAllProgress.current} de {exportAllProgress.total}. No cierres esta pantalla.</p>
            <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
              <div
                className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                style={{ width: `${exportAllProgress.total ? (exportAllProgress.current / exportAllProgress.total) * 100 : 0}%` }}
              ></div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-24 md:bottom-6 left-4 right-4 md:left-auto md:right-6 z-[70] animate-slideUp">
          <div className={`px-6 py-4 rounded-xl shadow-2xl text-white font-bold flex items-center space-x-3 text-base sm:text-lg ${toast.type === 'error' ? 'bg-red-600' : 'bg-slate-900'}`}>
            {toast.type === 'error' ? <AlertCircle size={24} /> : <Check size={24} className="text-green-400" />}
            <span>{toast.message}</span>
          </div>
        </div>
      )}

      {dialogConfig && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 text-center">
            <h3 className="text-2xl font-bold text-slate-900 mb-4">
              {dialogConfig.type === 'alert' ? 'Atención' : 'Confirmar'}
            </h3>
            <p className="text-slate-600 text-lg mb-8">{dialogConfig.message}</p>
            <div className="flex justify-center space-x-4">
              <button 
                onClick={() => setDialogConfig(null)}
                className="px-6 py-3 text-slate-600 hover:bg-slate-100 rounded-xl font-bold transition-colors text-lg"
              >
                {dialogConfig.type === 'alert' ? 'Entendido' : 'Cancelar'}
              </button>
              {dialogConfig.type === 'confirm' && (
                <button 
                  onClick={() => { dialogConfig.onConfirm(); setDialogConfig(null); }}
                  className="px-6 py-3 bg-red-600 text-white rounded-xl hover:bg-red-700 font-bold transition-colors shadow-md text-lg"
                >
                  Sí, Eliminar
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {generatedLetter && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl overflow-hidden">
             <div className="px-5 sm:px-8 py-4 sm:py-6 border-b flex justify-between items-center bg-gradient-to-r from-purple-50 to-white">
              <h3 className="text-2xl font-bold text-purple-900 flex items-center gap-3">
                <Sparkles size={28} className="text-purple-500"/> 
                {generatedLetter.title}
              </h3>
              <button onClick={() => setGeneratedLetter(null)} className="text-slate-400 hover:text-slate-600 bg-white p-2 rounded-full shadow-sm"><X size={24} /></button>
            </div>
            <div className="p-5 sm:p-8">
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 text-slate-800 whitespace-pre-wrap leading-relaxed text-lg">
                {generatedLetter.content}
              </div>
            </div>
            <div className="px-5 sm:px-8 py-4 sm:py-6 border-t bg-slate-50 flex justify-end space-x-4">
              <button onClick={() => setGeneratedLetter(null)} className="px-6 py-3 text-slate-600 hover:text-slate-800 font-bold text-lg">Cerrar</button>
              <button 
                onClick={() => copyToClipboard(generatedLetter.content)}
                className="px-8 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-bold shadow-md flex items-center gap-2 text-lg"
              >
                <Copy size={20} /> Copiar Texto
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="pb-28 md:pb-16 pt-4 md:pt-8">
        {activeDisco !== null ? renderSocioView() : (showGrid ? renderGrid() : renderInicio())}
      </main>

      {/* MODAL SOCIO */}
      {isSocioModalOpen && editingSocio && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl overflow-hidden my-2 sm:my-8">
            <div className="px-5 sm:px-8 py-4 sm:py-6 border-b bg-slate-50 flex justify-between items-center">
              <h3 className="text-2xl font-bold text-slate-800">
                {sociosMap[editingSocio.disco] ? 'Editar Datos' : 'Registrar Socio'} - Disco #{editingSocio.disco}
              </h3>
              <button onClick={() => setIsSocioModalOpen(false)} className="text-slate-400 hover:text-slate-600 bg-white p-2 rounded-full shadow-sm">
                <X size={24} />
              </button>
            </div>
            <div className="p-5 sm:p-8">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="col-span-2">
                  <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Nombres Completos</label>
                  <input type="text" className="w-full bg-slate-50 rounded-xl p-4 border border-slate-300 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-medium" 
                    value={editingSocio.nombre} onChange={e => setEditingSocio({...editingSocio, nombre: e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Cédula</label>
                  <input type="text" className="w-full bg-slate-50 rounded-xl p-4 border border-slate-300 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-medium" 
                    value={editingSocio.cedula} onChange={e => setEditingSocio({...editingSocio, cedula: e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Fecha de Ingreso</label>
                  <input type="date" className="w-full bg-slate-50 rounded-xl p-4 border border-slate-300 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-medium" 
                    value={editingSocio.fechaIngreso} onChange={e => setEditingSocio({...editingSocio, fechaIngreso: e.target.value})} />
                </div>

                <div>
                  <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Tipo de Licencia</label>
                  <select className="w-full bg-slate-50 rounded-xl p-4 border border-slate-300 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-medium"
                    value={editingSocio.tipoLicencia || ''} onChange={e => setEditingSocio({...editingSocio, tipoLicencia: e.target.value})}>
                    <option value="">Seleccione...</option>
                    {TIPOS_LICENCIA.map(tipo => <option key={tipo} value={tipo}>Tipo {tipo}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Caducidad de Licencia</label>
                  <input type="date" className="w-full bg-slate-50 rounded-xl p-4 border border-slate-300 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-medium" 
                    value={editingSocio.caducidadLicencia || ''} onChange={e => setEditingSocio({...editingSocio, caducidadLicencia: e.target.value})} />
                </div>
                
                <div className="col-span-2 mt-6 pt-6 border-t-2 border-slate-200">
                  <h4 className="text-lg font-bold text-blue-700 flex items-center gap-2 mb-4"><Truck size={20}/> DATOS DE VEHÍCULO</h4>
                </div>
                
                <div>
                  <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Placa</label>
                  <input type="text" className="w-full bg-slate-50 rounded-xl p-4 border border-slate-300 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-medium" 
                    value={editingSocio.placa} onChange={e => setEditingSocio({...editingSocio, placa: e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Año</label>
                  <input type="text" className="w-full bg-slate-50 rounded-xl p-4 border border-slate-300 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-medium" 
                    value={editingSocio.anio} onChange={e => setEditingSocio({...editingSocio, anio: e.target.value})} />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Marca / Modelo</label>
                  <input type="text" className="w-full bg-slate-50 rounded-xl p-4 border border-slate-300 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-medium" 
                    value={editingSocio.marca} onChange={e => setEditingSocio({...editingSocio, marca: e.target.value})} />
                </div>
              </div>
            </div>
            <div className="px-5 sm:px-8 py-4 sm:py-6 border-t bg-slate-50 flex justify-end space-x-4">
              <button onClick={() => setIsSocioModalOpen(false)} className="px-4 sm:px-6 py-3 text-slate-600 hover:text-slate-900 font-bold text-lg">Cancelar</button>
              <button 
                onClick={() => handleSaveSocio(editingSocio)}
                className="px-5 sm:px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold shadow-md transition-colors text-lg"
              >
                Guardar Cambios
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL COLABORADOR */}
      {isColabModalOpen && editingColab && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-5xl my-2 sm:my-8 overflow-hidden">
            <div className="px-5 sm:px-8 py-4 sm:py-6 border-b flex justify-between items-center bg-slate-50">
              <h3 className="text-2xl font-bold text-slate-800">
                {editingColab.id ? 'Editar Ficha de Colaborador' : 'Añadir Nuevo Colaborador'}
              </h3>
              <button onClick={() => setIsColabModalOpen(false)} className="text-slate-400 hover:text-slate-600 bg-white p-2 rounded-full shadow-sm">
                <X size={24} />
              </button>
            </div>
            
            <div className="p-5 sm:p-8">

              <div className="flex flex-col lg:flex-row gap-6 lg:gap-12">
                <div className="w-full lg:w-1/3 flex flex-col items-center">
                  <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-4 w-full text-center">Fotografía del Colaborador</label>
                  
                  <div className="relative w-56 h-72 bg-slate-50 rounded-2xl border-2 border-dashed border-slate-300 flex items-center justify-center overflow-hidden hover:bg-slate-100 hover:border-blue-500 transition-all cursor-pointer group shadow-inner">
                    {editingColab.fotoBase64 ? (
                      <img src={editingColab.fotoBase64} alt="Preview" className="w-full h-full object-cover" />
                    ) : (
                      <div className="text-center p-6">
                        <Camera className="mx-auto text-slate-400 mb-4 group-hover:text-blue-500 transition-colors" size={48} />
                        <span className="text-base font-bold text-slate-500 group-hover:text-blue-600 transition-colors">Clic para subir foto</span>
                      </div>
                    )}
                    <div className="absolute inset-0 bg-slate-900/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <span className="text-white text-lg font-bold bg-slate-900/50 px-6 py-3 rounded-xl border border-white/30 backdrop-blur-sm">Actualizar Foto</span>
                    </div>
                    <input 
                      type="file" 
                      accept="image/jpeg, image/png" 
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      onChange={async (e) => {
                        if (e.target.files && e.target.files[0]) {
                          const base64 = await processImage(e.target.files[0], false);
                          setEditingColab({...editingColab, fotoBase64: base64});
                        }
                      }}
                    />
                  </div>
                </div>

                <div className="w-full lg:w-2/3 grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div className="sm:col-span-2">
                    <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Nombres Completos</label>
                    <input type="text" required className="w-full bg-slate-50 rounded-xl p-4 border border-slate-300 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-bold text-slate-900" 
                      value={editingColab.nombre} onChange={e => setEditingColab({...editingColab, nombre: e.target.value})} />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Cédula</label>
                    <input type="text" required className="w-full bg-slate-50 rounded-xl p-4 border border-slate-300 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-bold text-slate-900" 
                      value={editingColab.cedula} onChange={e => setEditingColab({...editingColab, cedula: e.target.value})} />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Placa Vehículo Asignado</label>
                    <input type="text" className="w-full bg-slate-50 rounded-xl p-4 border border-slate-300 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-bold text-slate-900" 
                      value={editingColab.placaVehiculo} onChange={e => setEditingColab({...editingColab, placaVehiculo: e.target.value})} />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Tipo de Licencia</label>
                    <select className="w-full bg-slate-50 rounded-xl p-4 border border-slate-300 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-bold text-slate-900"
                      value={editingColab.tipoLicencia} onChange={e => setEditingColab({...editingColab, tipoLicencia: e.target.value})}>
                      <option value="">Seleccione...</option>
                      {TIPOS_LICENCIA.map(tipo => <option key={tipo} value={tipo}>Tipo {tipo}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Caducidad de Licencia</label>
                    <input type="date" className="w-full bg-slate-50 rounded-xl p-4 border border-slate-300 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-bold text-slate-900" 
                      value={editingColab.caducidadLicencia} onChange={e => setEditingColab({...editingColab, caducidadLicencia: e.target.value})} />
                  </div>
                  
                  <div className="sm:col-span-2 mt-6 pt-6 border-t-2 border-slate-200">
                    <h4 className="text-lg font-bold text-blue-700 flex items-center gap-2 mb-4"><Check size={20}/> DATOS DE APROBACIÓN DE CARPETA</h4>
                  </div>
                  
                  <div className="sm:col-span-2">
                    <label className="block text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Aprobado por (Nombre y Cargo)</label>
                    <input 
                      type="text" 
                      className="w-full bg-slate-50 rounded-xl p-4 border border-slate-300 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-bold text-slate-900" 
                      value={editingColab.aprobadoPor} 
                      onChange={e => setEditingColab({...editingColab, aprobadoPor: e.target.value})} 
                      list="cargos-list"
                    />
                    <datalist id="cargos-list">
                      <option value={DEFAULT_APROBADOR} />
                      <option value="Presidente de Administración" />
                      <option value="Vocal de Vigilancia" />
                    </datalist>
                    <p className="text-sm text-slate-500 mt-2 italic">Puedes borrar y escribir otro nombre si el cargo cambia temporal o permanentemente.</p>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-sm font-bold text-blue-700 uppercase tracking-wider mb-2">Fecha de Aprobación</label>
                    <input type="date" className="w-full bg-slate-50 rounded-xl p-4 border-2 border-blue-200 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-lg font-bold text-slate-900" 
                      value={editingColab.fechaAprobacion} onChange={e => setEditingColab({...editingColab, fechaAprobacion: e.target.value})} />
                  </div>
                </div>
              </div>
            </div>
            
            <div className="px-5 sm:px-8 py-4 sm:py-6 border-t bg-slate-50 flex justify-end space-x-4">
              <button onClick={() => setIsColabModalOpen(false)} className="px-4 sm:px-6 py-3 text-slate-600 hover:text-slate-900 font-bold text-lg">Cancelar</button>
              <button 
                onClick={() => {
                  if(!editingColab.nombre || !editingColab.cedula) {
                    setDialogConfig({ type: 'alert', message: "El nombre y la cédula son campos obligatorios." });
                    return;
                  }
                  handleSaveColaborador(editingColab);
                }}
                className="px-5 sm:px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold shadow-md transition-colors text-lg"
              >
                Guardar Ficha
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}