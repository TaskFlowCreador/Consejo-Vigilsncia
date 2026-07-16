import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged 
} from 'firebase/auth';
import { 
  getFirestore, collection, onSnapshot, doc, setDoc, deleteDoc, addDoc 
} from 'firebase/firestore';
import { 
  Search, Edit, Trash2, UserPlus, Image as ImageIcon, Camera, X, Check, FileText, Users, Truck, Sparkles, Copy, AlertCircle, ScanText, UploadCloud
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
  
  // Gemini AI States
  const [isAnalyzingImage, setIsAnalyzingImage] = useState(false);
  const [generatingLetterId, setGeneratingLetterId] = useState(null);
  const [generatedLetter, setGeneratedLetter] = useState(null);

  const DEFAULT_APROBADOR = "Cuenca Rivera Ramon Alejandro - Presidente de Vigilancia";

  // Cargar script para exportar a PNG (html2canvas)
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    script.async = true;
    document.body.appendChild(script);
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

        let importedCount = 0;

        for (let i = headerIndex + 1; i < rows.length; i++) {
          const cols = rows[i];
          if (!cols || !cols[idxDisco]) continue;

          const discoNum = parseInt(cols[idxDisco].trim());
          if (isNaN(discoNum) || discoNum < 1 || discoNum > 61) continue;

          const socioData = {
            disco: discoNum,
            nombre: idxNombre !== -1 ? (cols[idxNombre] || '').trim() : '',
            cedula: idxCedula !== -1 ? (cols[idxCedula] || '').trim() : '',
            fechaIngreso: idxFecha !== -1 ? (cols[idxFecha] || '').trim() : '',
            placa: idxPlaca !== -1 ? (cols[idxPlaca] || '').trim() : '',
            anio: idxAnio !== -1 ? (cols[idxAnio] || '').trim() : '',
            marca: idxMarca !== -1 ? (cols[idxMarca] || '').trim() : ''
          };

          const socioDocRef = getDocRef(user.uid, 'socios', discoNum.toString());
          await setDoc(socioDocRef, socioData);
          importedCount++;
        }

        showToast(`¡Se importaron ${importedCount} socios exitosamente!`);
      } catch (error) {
        console.error(error);
        showToast("Error al procesar el archivo CSV.", "error");
      } finally {
        setIsImporting(false);
        event.target.value = '';
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // --- GEMINI ACTIONS ---
  const handleAIExtractFromLicense = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsAnalyzingImage(true);
    try {
      const base64Img = await processImage(file, true);
      const prompt = `Extrae la siguiente información de esta licencia de conducir o documento de identidad de Ecuador u otro país. 
      Devuelve los datos estrictamente con la estructura solicitada. 
      'nombre' (Nombres y apellidos completos), 
      'cedula' (número de identificación o cédula), 
      'tipoLicencia' (Solo la letra del tipo de licencia, ej. A, B, C, D, E, F, G. Si no hay, déjalo vacío), 
      'caducidadLicencia' (Fecha de expiración en formato YYYY-MM-DD. Si no hay, déjalo vacío).`;
      
      const extractedData = await callGeminiApi(prompt, true, base64Img);
      
      setEditingColab(prev => ({
        ...prev,
        nombre: extractedData.nombre || prev.nombre,
        cedula: extractedData.cedula || prev.cedula,
        tipoLicencia: extractedData.tipoLicencia || prev.tipoLicencia,
        caducidadLicencia: extractedData.caducidadLicencia || prev.caducidadLicencia
      }));
      
      showToast("¡Datos extraídos con éxito usando IA!");
    } catch (error) {
      showToast("No se pudo extraer la información. Intenta con una foto más clara.", "error");
    } finally {
      setIsAnalyzingImage(false);
      event.target.value = '';
    }
  };

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
  const handleSearch = (e) => {
    e.preventDefault();
    const discoNum = parseInt(searchDisco);
    if (discoNum >= 1 && discoNum <= 61) {
      setActiveDisco(discoNum);
      setSearchDisco('');
    } else {
      setDialogConfig({ type: 'alert', message: "Por favor ingrese un número de disco válido (1 al 61)." });
    }
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

  // --- RENDERIZADO PRINCIPAL ---
  if (!user) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500 font-sans">Conectando al sistema seguro...</div>;
  }

  // Pantalla de inicio: buscador central estilo "Google" en lugar de los 61 cuadros de golpe
  const renderInicio = () => {
    const totalSocios = Object.keys(sociosMap).length;
    return (
      <div className="max-w-2xl mx-auto px-6 pt-10 md:pt-20 flex flex-col items-center text-center">
        <div className="bg-blue-600 p-4 rounded-2xl shadow-lg shadow-blue-200 mb-6">
          <Truck size={36} className="text-white" />
        </div>
        <h2 className="text-2xl md:text-3xl font-bold text-slate-800 mb-2">Buscar Socio por Disco</h2>
        <p className="text-slate-500 mb-8">Ingresa el número de disco (1 al 61) y presiona Enter para ver su ficha al instante.</p>

        <form onSubmit={handleSearch} className="w-full">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none">
              <Search className="h-6 w-6 text-slate-400" />
            </div>
            <input
              autoFocus
              type="number"
              min="1" max="61"
              className="block w-full pl-14 pr-4 py-5 border border-slate-200 rounded-2xl bg-white text-slate-900 placeholder-slate-400 shadow-md focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-400 transition-all text-xl"
              placeholder="N.º de disco..."
              value={searchDisco}
              onChange={(e) => setSearchDisco(e.target.value)}
            />
          </div>
        </form>

        <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
          <span className="text-sm text-slate-400">{totalSocios} de 61 discos registrados</span>
          <span className="text-slate-300">•</span>
          <button
            onClick={() => setShowGrid(true)}
            className="text-sm font-semibold text-blue-600 hover:text-blue-700 underline underline-offset-2"
          >
            Ver todos los discos
          </button>
        </div>

        <div className="mt-4">
          <input type="file" id="csv-upload" accept=".csv" className="hidden" onChange={handleCSVUpload} />
          <button
            onClick={() => document.getElementById('csv-upload').click()}
            disabled={isImporting}
            className="flex items-center space-x-2 text-slate-500 hover:text-slate-700 px-4 py-2 rounded-lg font-medium transition-colors text-sm"
            title="Sube el archivo CSV para importar los datos de los socios"
          >
            {isImporting ? <span className="animate-pulse">Importando...</span> : <><UploadCloud size={16}/> <span>Importar socios desde CSV</span></>}
          </button>
        </div>
      </div>
    );
  };

  const renderGrid = () => {
    const discos = Array.from({ length: 61 }, (_, i) => i + 1);
    return (
      <div className="max-w-7xl mx-auto p-6">
        <div className="flex flex-wrap gap-3 justify-between items-center mb-6 bg-white p-4 rounded-2xl shadow-sm border border-slate-100">
          <div>
            <button
              onClick={() => setShowGrid(false)}
              className="text-slate-400 hover:text-slate-700 text-sm font-medium mb-1 flex items-center gap-1"
            >
              ← Volver al buscador
            </button>
            <h2 className="text-xl font-bold text-slate-800">Directorio de Unidades (Discos)</h2>
            <p className="text-sm text-slate-500">Selecciona un disco para administrar el socio y sus colaboradores.</p>
          </div>

          <div className="relative">
            <input type="file" id="csv-upload-grid" accept=".csv" className="hidden" onChange={handleCSVUpload} />
            <button 
              onClick={() => document.getElementById('csv-upload-grid').click()}
              disabled={isImporting}
              className="flex items-center space-x-2 bg-slate-800 hover:bg-slate-700 text-white px-4 py-2.5 rounded-xl font-medium transition-colors shadow-sm text-sm"
              title="Sube el archivo CSV para importar los datos de los socios"
            >
              {isImporting ? <span className="animate-pulse">Importando...</span> : <><UploadCloud size={18}/> <span className="hidden sm:inline">Importar Socios</span></>}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {discos.map(disco => {
            const socio = sociosMap[disco];
            const hasSocio = !!socio;
            return (
              <button
                key={disco}
                onClick={() => setActiveDisco(disco)}
                className={`p-4 rounded-2xl border transition-all duration-200 flex flex-col items-center justify-center space-y-1.5 hover:-translate-y-0.5
                  ${hasSocio 
                    ? 'border-blue-100 bg-blue-50/70 text-blue-900 hover:bg-blue-50 hover:shadow-lg hover:shadow-blue-100' 
                    : 'border-slate-100 bg-white text-slate-300 hover:border-slate-200 hover:shadow-md'}`}
              >
                <span className="text-[11px] font-semibold tracking-wide opacity-60">DISCO</span>
                <span className="text-3xl font-bold">{disco}</span>
                <span className="text-xs text-center truncate w-full px-1 font-medium">
                  {hasSocio ? socio.nombre.split(' ').slice(0,2).join(' ') : 'Vacante'}
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
        <div className="w-full max-w-5xl mb-4 flex justify-between">
          <button 
            onClick={() => setActiveDisco(null)}
            className="text-slate-500 hover:text-slate-800 flex items-center text-sm font-medium transition-colors bg-white px-4 py-2 rounded-lg shadow-sm border border-slate-200 w-max"
          >
            ← Volver al panel de Discos
          </button>

          {!isExporting && socio && (
            <button 
              onClick={exportToImage}
              className="flex items-center space-x-2 bg-blue-600 text-white hover:bg-blue-700 px-6 py-2 rounded-lg transition-all text-sm font-bold shadow-md"
            >
              <ImageIcon size={20} />
              <span>Descargar Ficha (Imagen)</span>
            </button>
          )}
        </div>

        <div id="ficha-export" className="bg-white rounded-xl shadow-xl border border-slate-300 overflow-hidden w-full max-w-5xl">
          
          <div className="bg-slate-900 px-8 py-8 text-white flex flex-col justify-center items-center border-b-4 border-blue-600 text-center">
            <h2 className="text-2xl md:text-3xl font-extrabold uppercase tracking-widest text-white">
              Registro Colaboradores
            </h2>
            <h3 className="text-xl md:text-2xl font-bold text-blue-300 mt-2 uppercase tracking-wide">
              Consejo de Vigilancia 2026-2027
            </h3>
          </div>
          
          <div className="p-8 md:p-12">
            <div className="mb-12">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end border-b-2 border-slate-200 pb-4 mb-6 gap-4">
                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                  <h3 className="text-2xl font-bold text-slate-800 flex items-center gap-3">
                    <Users className="text-blue-600" size={28}/> Datos del Socio Propietario
                  </h3>
                  <div className="bg-blue-600 text-white text-lg font-bold px-5 py-2 rounded-lg shadow-sm inline-block whitespace-nowrap">
                    SOCIO DISCO {activeDisco}
                  </div>
                </div>

                {!isExporting && (
                  <button 
                    onClick={() => {
                      setEditingSocio(socio || { disco: activeDisco, nombre: '', cedula: '', fechaIngreso: '', placa: '', anio: '', marca: '' });
                      setIsSocioModalOpen(true);
                    }}
                    className="text-blue-600 hover:text-blue-800 text-sm font-bold flex items-center gap-1 transition-colors bg-blue-50 px-3 py-1.5 rounded-md shrink-0"
                  >
                    <Edit size={16} /> {socio ? 'Editar Datos' : 'Registrar Socio'}
                  </button>
                )}
              </div>

              {socio ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 bg-slate-50 p-8 rounded-xl border border-slate-200">
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
                        setEditingSocio({ disco: activeDisco, nombre: '', cedula: '', fechaIngreso: '', placa: '', anio: '', marca: '' });
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
              <div className="p-8 md:p-12 pt-0 md:pt-0">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end border-b-2 border-slate-200 pb-4 mb-6 gap-4">
                  <h3 className="text-2xl font-bold text-slate-800 flex items-center gap-3">
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
                    {socioColabs.map((colab, index) => (
                      <div key={colab.id} className="bg-white border border-slate-300 rounded-xl shadow-sm flex flex-col md:flex-row hover:border-blue-300 transition-colors overflow-hidden">
                        
                        <div className="p-6 flex flex-1 gap-6">
                          <div className="w-36 h-48 flex-shrink-0 bg-slate-100 rounded-lg border border-slate-300 flex items-center justify-center overflow-hidden relative shadow-inner">
                            {colab.fotoBase64 ? (
                              <img src={colab.fotoBase64} alt={colab.nombre} className="w-full h-full object-cover" />
                            ) : (
                              <div className="text-center">
                                <Camera className="text-slate-400 mx-auto" size={40} />
                                <span className="text-xs text-slate-500 mt-2 block font-medium">Sin Foto</span>
                              </div>
                            )}
                          </div>
                          
                          <div className="flex-grow flex flex-col justify-center">
                            <div className="text-sm font-bold text-blue-600 mb-2 uppercase tracking-wider">COLABORADOR #{index + 1}</div>
                            <h4 className="font-bold text-slate-900 leading-tight text-2xl mb-4">{colab.nombre}</h4>
                            
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-6 text-base text-slate-700">
                              <p><span className="font-bold text-slate-900">Cédula:</span> {colab.cedula}</p>
                              <p><span className="font-bold text-slate-900">Licencia:</span> {colab.tipoLicencia} (Vence: {colab.caducidadLicencia})</p>
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
                    ))}
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
    { key: 'importar', label: 'Importar datos (CSV)', icon: UploadCloud, onClick: () => { document.getElementById('csv-upload-sidebar').click(); setSidebarOpen(false); } },
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

      {/* --- ENCABEZADO (móvil + acceso rápido) --- */}
      <header className="md:hidden bg-slate-900 shadow-lg sticky top-0 z-20 border-b-4 border-blue-600">
        <div className="px-4 h-16 flex items-center justify-between">
          <button onClick={() => { setActiveDisco(null); setShowGrid(false); }} className="flex items-center gap-2 text-white">
            <div className="bg-blue-600 p-2 rounded-lg">
              <Truck size={20} className="text-white" />
            </div>
            <span className="font-bold text-sm">Cooperativa N°14</span>
          </button>
          <button onClick={() => setSidebarOpen(true)} className="text-white p-2 -mr-2" aria-label="Abrir menú">
            <span className="block w-6 h-0.5 bg-white mb-1.5"></span>
            <span className="block w-6 h-0.5 bg-white mb-1.5"></span>
            <span className="block w-6 h-0.5 bg-white"></span>
          </button>
        </div>
      </header>

      {/* --- MENÚ LATERAL (móvil, se desliza encima) --- */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-30 flex">
          <div className="w-72 bg-slate-900 text-white h-full p-4 flex flex-col animate-fadeIn">
            <div className="flex justify-between items-center mb-6 px-2">
              <span className="font-bold">Menú</span>
              <button onClick={() => setSidebarOpen(false)} className="text-slate-400 p-2"><X size={22} /></button>
            </div>
            <nav className="space-y-1">
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
          </div>
          <div className="flex-1 bg-slate-900/60" onClick={() => setSidebarOpen(false)}></div>
        </div>
      )}

      <div className="flex-1 min-w-0">

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 animate-slideUp">
          <div className={`px-6 py-4 rounded-xl shadow-2xl text-white font-bold flex items-center space-x-3 text-lg ${toast.type === 'error' ? 'bg-red-600' : 'bg-slate-900'}`}>
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
             <div className="px-8 py-6 border-b flex justify-between items-center bg-gradient-to-r from-purple-50 to-white">
              <h3 className="text-2xl font-bold text-purple-900 flex items-center gap-3">
                <Sparkles size={28} className="text-purple-500"/> 
                {generatedLetter.title}
              </h3>
              <button onClick={() => setGeneratedLetter(null)} className="text-slate-400 hover:text-slate-600 bg-white p-2 rounded-full shadow-sm"><X size={24} /></button>
            </div>
            <div className="p-8">
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 text-slate-800 whitespace-pre-wrap leading-relaxed text-lg">
                {generatedLetter.content}
              </div>
            </div>
            <div className="px-8 py-6 border-t bg-slate-50 flex justify-end space-x-4">
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

      <main className="pb-16 pt-8">
        {activeDisco !== null ? renderSocioView() : (showGrid ? renderGrid() : renderInicio())}
      </main>

      {/* MODAL SOCIO */}
      {isSocioModalOpen && editingSocio && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl overflow-hidden my-8">
            <div className="px-8 py-6 border-b bg-slate-50 flex justify-between items-center">
              <h3 className="text-2xl font-bold text-slate-800">
                {sociosMap[editingSocio.disco] ? 'Editar Datos' : 'Registrar Socio'} - Disco #{editingSocio.disco}
              </h3>
              <button onClick={() => setIsSocioModalOpen(false)} className="text-slate-400 hover:text-slate-600 bg-white p-2 rounded-full shadow-sm">
                <X size={24} />
              </button>
            </div>
            <div className="p-8">
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
            <div className="px-8 py-6 border-t bg-slate-50 flex justify-end space-x-4">
              <button onClick={() => setIsSocioModalOpen(false)} className="px-6 py-3 text-slate-600 hover:text-slate-900 font-bold text-lg">Cancelar</button>
              <button 
                onClick={() => handleSaveSocio(editingSocio)}
                className="px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold shadow-md transition-colors text-lg"
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
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-5xl my-8 overflow-hidden">
            <div className="px-8 py-6 border-b flex justify-between items-center bg-slate-50">
              <h3 className="text-2xl font-bold text-slate-800">
                {editingColab.id ? 'Editar Ficha de Colaborador' : 'Añadir Nuevo Colaborador'}
              </h3>
              <button onClick={() => setIsColabModalOpen(false)} className="text-slate-400 hover:text-slate-600 bg-white p-2 rounded-full shadow-sm">
                <X size={24} />
              </button>
            </div>
            
            <div className="p-8">
              <div className="bg-gradient-to-r from-blue-50 to-slate-50 border border-blue-200 rounded-2xl p-6 mb-8 flex flex-col md:flex-row justify-between items-center gap-6 shadow-sm">
                <div className="flex items-center gap-5">
                  <div className="p-4 bg-blue-100 text-blue-700 rounded-2xl shadow-inner"><Sparkles size={32}/></div>
                  <div>
                    <h4 className="text-xl font-bold text-blue-900 mb-1">Autocompletado con Inteligencia Artificial</h4>
                    <p className="text-base text-blue-800">Sube la foto de la licencia de conducir y extraeremos los datos por ti automáticamente.</p>
                  </div>
                </div>
                <div className="relative flex-shrink-0 w-full md:w-auto">
                  <input type="file" id="ai-license-upload" accept="image/*" className="hidden" onChange={handleAIExtractFromLicense} />
                  <button 
                    onClick={() => document.getElementById('ai-license-upload').click()}
                    disabled={isAnalyzingImage}
                    className="w-full md:w-auto bg-white border-2 border-blue-300 text-blue-700 font-bold px-6 py-3.5 rounded-xl text-lg hover:bg-blue-50 hover:border-blue-400 transition-all shadow-md flex items-center justify-center gap-3"
                  >
                    {isAnalyzingImage ? (
                      <span className="animate-pulse">Analizando documento...</span>
                    ) : (
                      <><ScanText size={22}/> ✨ Extraer de Licencia</>
                    )}
                  </button>
                </div>
              </div>

              <div className="flex flex-col lg:flex-row gap-12">
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
                      <option value="A">Tipo A</option>
                      <option value="B">Tipo B</option>
                      <option value="C">Tipo C</option>
                      <option value="D">Tipo D</option>
                      <option value="E">Tipo E</option>
                      <option value="F">Tipo F</option>
                      <option value="G">Tipo G</option>
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
            
            <div className="px-8 py-6 border-t bg-slate-50 flex justify-end space-x-4">
              <button onClick={() => setIsColabModalOpen(false)} className="px-6 py-3 text-slate-600 hover:text-slate-900 font-bold text-lg">Cancelar</button>
              <button 
                onClick={() => {
                  if(!editingColab.nombre || !editingColab.cedula) {
                    setDialogConfig({ type: 'alert', message: "El nombre y la cédula son campos obligatorios." });
                    return;
                  }
                  handleSaveColaborador(editingColab);
                }}
                className="px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold shadow-md transition-colors text-lg"
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
