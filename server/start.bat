@echo off
setlocal
chcp 65001 >nul
title PS4Store - Serveur
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js est introuvable. Installez-le depuis https://nodejs.org puis relancez ce script.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [PS4Store] Installation des dependances...
  call npm install --omit=dev
  if errorlevel 1 (
    echo [ERREUR] L'installation des dependances a echoue.
    pause
    exit /b 1
  )
)

where pm2 >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] PM2 n'est pas installe.
  echo          Installez-le avec :  npm install -g pm2
  echo          puis relancez ce script.
  pause
  exit /b 1
)

call pm2 describe ps4store >nul 2>nul
if errorlevel 1 (
  echo [PS4Store] Demarrage du serveur avec PM2...
  call pm2 start server.js --name ps4store --time --max-memory-restart 300M
) else (
  echo [PS4Store] Redemarrage du serveur...
  call pm2 restart ps4store --update-env
)
if errorlevel 1 (
  echo [ERREUR] PM2 n'a pas pu lancer le serveur. Consultez :  pm2 logs ps4store
  pause
  exit /b 1
)

call pm2 save >nul

echo.
echo [PS4Store] Serveur en ligne : http://localhost:3000
echo            Journaux : pm2 logs ps4store
echo            Arret    : pm2 stop ps4store
echo.
pause
endlocal
