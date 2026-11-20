@echo off
setlocal
chcp 65001 >nul
title PS4Store - Bot Discord
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js est introuvable. Installez-le depuis https://nodejs.org puis relancez ce script.
  pause
  exit /b 1
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo [Bot] .env cree. Renseignez-y le token et les identifiants, puis relancez ce script.
  start notepad ".env"
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [Bot] Installation des dependances...
  call npm install --omit=dev
  if errorlevel 1 (
    echo [ERREUR] L'installation des dependances a echoue.
    pause
    exit /b 1
  )
)

where pm2 >nul 2>nul
if errorlevel 1 goto standalone

call pm2 describe ps4store-bot >nul 2>nul
if errorlevel 1 (
  echo [Bot] Demarrage avec PM2...
  call pm2 start index.js --name ps4store-bot --time --max-memory-restart 300M
) else (
  echo [Bot] Redemarrage avec PM2...
  call pm2 restart ps4store-bot --update-env
)
call pm2 save >nul
echo.
echo [Bot] En ligne via PM2.  Journaux : pm2 logs ps4store-bot   Arret : pm2 stop ps4store-bot
pause
exit /b 0

:standalone
echo [Bot] PM2 absent : lancement standalone (Ctrl+C pour arreter).
:loop
node index.js
echo [Bot] Arret du processus (code %errorlevel%). Redemarrage dans 5 s...
timeout /t 5 /nobreak >nul
goto loop
