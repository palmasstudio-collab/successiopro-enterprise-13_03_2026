<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# SuccessioPro Enterprise

SuccessioPro Enterprise è una piattaforma avanzata per la gestione delle pratiche di successione, volture e consulenze tecniche. Integra direttamente Google Drive per l'archiviazione sicura dei documenti e la sincronizzazione in tempo reale.

## Caratteristiche principali

- **Gestione Pratiche**: Creazione, monitoraggio e archiviazione di pratiche (Successioni, Volture, Consulenze).
- **Integrazione Google Drive**: Sincronizzazione automatica del database e dei documenti su cartelle Drive dedicate.
- **Gestione Eredi**: Database dettagliato degli eredi con caricamento documenti specifico.
- **Modulo Economico**: Tracciamento di entrate, uscite, anticipi e prelievi con bilancio in tempo reale.
- **Generazione Documenti**: Esportazione automatica in PDF (Ricevute) ed Excel (Archivio).

## Requisiti

- Node.js (v18 o superiore)
- Un progetto Google Cloud con Google Drive API abilitate
- OAuth 2.0 Client ID

## Installazione Locale

1. Clona il repository:
   ```bash
   git clone https://github.com/tuo-username/successiopro-enterprise.git
   cd successiopro-enterprise
   ```

2. Installa le dipendenze:
   ```bash
   npm install
   ```

3. Configura le variabili d'ambiente:
   Crea un file `.env` basandoti su `.env.example` e inserisci le tue chiavi:
   ```env
   VITE_GOOGLE_CLIENT_ID=tuo_client_id
   VITE_GOOGLE_API_KEY=tua_api_key
   VITE_ROOT_FOLDER_ID=id_cartella_root
   VITE_SENT_FOLDER_ID=id_cartella_inviate
   VITE_DB_FOLDER_ID=id_cartella_database
   ```

4. Avvia il server di sviluppo:
   ```bash
   npm run dev
   ```

## Distribuzione su Cloud Run

Il progetto è pronto per essere distribuito su Google Cloud Run.

1. Costruisci l'immagine Docker (o usa Cloud Build):
   ```bash
   gcloud builds submit --tag gcr.io/tuo-progetto/successiopro
   ```

2. Distribuisci su Cloud Run:
   ```bash
   gcloud run deploy successiopro --image gcr.io/tuo-progetto/successiopro --platform managed
   ```

## Licenza

Proprietà riservata - Palmas Studio.
