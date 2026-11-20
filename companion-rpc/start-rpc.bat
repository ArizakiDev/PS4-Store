@echo off
setlocal
cd /d "%~dp0"
title PS4Store - Discord Rich Presence

where node >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js est introuvable. Installez-le depuis https://nodejs.org puis relancez ce script.
  pause
  exit /b 1
)

if not exist "config.json" (
  echo.
  echo === Premiere utilisation : configuration ===
  echo 1^) Adresse du serveur PS4Store, ex. http://192.168.1.100:3000
  set /p SERVER=   Adresse :
  echo 2^) Jeton RPC : copiez-le depuis la page "Mon compte" du site.
  set /p TOKEN=   Jeton :
  echo 3^) Application ID Discord : creez une application sur https://discord.com/developers/applications
  echo    ^(son nom s'affichera dans "Joue a ..."^) puis copiez son "Application ID".
  set /p CLIENT=   Application ID :
  > config.json echo {
  >> config.json echo   "server_url": "%SERVER%",
  >> config.json echo   "rpc_token": "%TOKEN%",
  >> config.json echo   "discord_client_id": "%CLIENT%"
  >> config.json echo }
  echo.
  echo Configuration enregistree dans config.json ^(supprimez ce fichier pour recommencer^).
)

echo.
echo Discord doit etre ouvert sur cet ordinateur. Laissez cette fenetre ouverte pendant que vous jouez.
node index.js
echo.
echo Le client compagnon s'est arrete.
pause
endlocal
