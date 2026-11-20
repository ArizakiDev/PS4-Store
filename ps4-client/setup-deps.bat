@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist external mkdir external

echo Telechargement de stb_image.h et stb_truetype.h depuis github.com/nothings/stb ...
curl -fL -o "external\stb_image.h" "https://raw.githubusercontent.com/nothings/stb/master/stb_image.h"
if errorlevel 1 goto :fail
curl -fL -o "external\stb_truetype.h" "https://raw.githubusercontent.com/nothings/stb/master/stb_truetype.h"
if errorlevel 1 goto :fail

echo.
echo [OK] En-tetes installes dans external\.
echo.
echo Reste a faire manuellement :
echo   - assets\fonts\font.ttf : une police libre au format TTF (ex. Inter, licence OFL).
echo   - external\libjbc\jbc.h : libjbc (voir README.md).
endlocal
exit /b 0

:fail
echo [ECHEC] Telechargement impossible.
endlocal
exit /b 1
