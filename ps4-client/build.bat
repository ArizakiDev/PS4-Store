@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

if not defined DOTNET_ROLL_FORWARD set "DOTNET_ROLL_FORWARD=Major"


set "TITLE_ID=PSTR00001"
set "CONTENT_ID=IV0000-PSTR00001_00-PS4STORE00000000"
set "APP_NAME=PS4Store"
set "APP_VERSION=01.47"
set "SYSTEM_VER=84213760"
if not defined EXTRA_LIBS set "EXTRA_LIBS="
echo %APP_VERSION%| findstr /r /b /e "[0-9][0-9]\.[0-9][0-9]" >nul || ( echo [ERREUR] APP_VERSION "%APP_VERSION%" invalide : format XX.YY attendu ^(ex. 01.31^). & goto :fail )

if not defined SFO_ATTRIBUTE set "SFO_ATTRIBUTE=0"
if not defined SFO_APP_TYPE set "SFO_APP_TYPE=1"
if not defined SFO_CATEGORY set "SFO_CATEGORY=gd"

if not defined OO_PS4_TOOLCHAIN (
  echo [ERREUR] La variable d'environnement OO_PS4_TOOLCHAIN n'est pas definie.
  echo          Definissez-la sur le dossier racine d'OpenOrbis, ex. C:\OpenOrbis
  goto :fail
)
set "TC=%OO_PS4_TOOLCHAIN%"
set "BIN=%TC%\bin\windows"
if not exist "%BIN%\create-fself.exe" (
  echo [ERREUR] Outils OpenOrbis introuvables dans "%BIN%".
  goto :fail
)
if not exist "%TC%\lib\libSDL2.a" (
  echo [ERREUR] "%TC%\lib\libSDL2.a" introuvable : utilisez une release recente d'OpenOrbis ^(^>= 0.5.x^).
  goto :fail
)

if not exist "external\stb_image.h" ( echo [ERREUR] external\stb_image.h manquant. Lancez setup-deps.bat. & goto :fail )
if not exist "external\stb_truetype.h" ( echo [ERREUR] external\stb_truetype.h manquant. Lancez setup-deps.bat. & goto :fail )
if not exist "assets\fonts\font.ttf" ( echo [ERREUR] assets\fonts\font.ttf manquant. Voir README.md ^(police libre, ex. Inter^). & goto :fail )
if not exist "external\libjbc\jbc.h" echo [ATTENTION] external\libjbc\jbc.h absent : le client sera compile SANS sortie de sandbox. Voir README.md.

set "MODDIR="
if exist "%TC%\samples\hello_world\sce_module\libc.prx" set "MODDIR=%TC%\samples\hello_world\sce_module"
if not defined MODDIR if exist "%TC%\src\modules\libc.prx" set "MODDIR=%TC%\src\modules"
if not defined MODDIR ( echo [ERREUR] libc.prx / libSceFios2.prx introuvables dans le toolchain. & goto :fail )
set "RIGHT="
if exist "%TC%\samples\hello_world\sce_sys\about\right.sprx" set "RIGHT=%TC%\samples\hello_world\sce_sys\about\right.sprx"
if not defined RIGHT if exist "%TC%\src\modules\right.sprx" set "RIGHT=%TC%\src\modules\right.sprx"

set "PATH=%BIN%;%PATH%"
set "OUT=build"
if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%\obj" "%OUT%\gen" "%OUT%\pkg\sce_sys\about" "%OUT%\pkg\sce_module" "%OUT%\pkg\assets\fonts" "%OUT%\pkg\assets\misc" || goto :fail

if not exist "assets\locales" mkdir "assets\locales"
for %%L in (fr en es) do if exist "..\locales\%%L.json" copy /y "..\locales\%%L.json" "assets\locales\%%L.json" >nul
for %%L in (fr en es) do if not exist "assets\locales\%%L.json" ( echo [ERREUR] assets\locales\%%L.json manquant. & goto :fail )

> "%OUT%\gen\ps4store_version.h" echo #pragma once
>> "%OUT%\gen\ps4store_version.h" echo #define APP_VERSION "%APP_VERSION%"
>> "%OUT%\gen\ps4store_version.h" echo #define APP_TITLE_ID "%TITLE_ID%"

echo.
echo === 1/5 Compilation ===
set "OBJS="
for %%F in (src\*.cpp) do (
  echo   %%~nxF
  clang++ --target=x86_64-pc-freebsd12-elf -std=gnu++17 -O2 -fexceptions -fPIC -funwind-tables -c ^
    -isysroot "%TC%" -isystem "%TC%\include" -isystem "%TC%\include\c++\v1" -isystem "%TC%\include\SDL2" ^
    -DAPP_VERSION_STR=\"%APP_VERSION%\" -Isrc -I"%OUT%\gen" -Iexternal "%%F" -o "%OUT%\obj\%%~nF.o"
  if errorlevel 1 goto :fail
  set "OBJS=!OBJS! "%OUT%\obj\%%~nF.o""
)

echo.
echo === 2/5 Edition de liens ===
ld.lld -m elf_x86_64 -pie --script "%TC%\link.x" --eh-frame-hdr -o "%OUT%\eboot.elf" ^
  !OBJS! -L"%TC%\lib" ^
  -lc -lkernel -lc++ -lSDL2 -lSceUserService -lScePad -lSceNet -lSceSsl -lSceHttp ^
  -lSceSystemService -lSceAppInstUtil -lSceBgft -lSceVideoOut -lSceAudioOut -lSceSysmodule -lSceImeDialog -lSceCommonDialog %EXTRA_LIBS% ^
  "%TC%\lib\crt1.o"
if errorlevel 1 goto :fail

echo.
echo === 3/5 param.sfo ^(CATEGORY=%SFO_CATEGORY% APP_TYPE=%SFO_APP_TYPE% ATTRIBUTE=%SFO_ATTRIBUTE%^) ===
set "SFO=%OUT%\pkg\sce_sys\param.sfo"
PkgTool.Core sfo_new "%SFO%" || goto :fail
PkgTool.Core sfo_setentry "%SFO%" APP_TYPE --type Integer --maxsize 4 --value %SFO_APP_TYPE% || goto :fail
PkgTool.Core sfo_setentry "%SFO%" APP_VER --type Utf8 --maxsize 8 --value "%APP_VERSION%" || goto :fail
PkgTool.Core sfo_setentry "%SFO%" ATTRIBUTE --type Integer --maxsize 4 --value %SFO_ATTRIBUTE% || goto :fail
PkgTool.Core sfo_setentry "%SFO%" CATEGORY --type Utf8 --maxsize 4 --value "%SFO_CATEGORY%" || goto :fail
PkgTool.Core sfo_setentry "%SFO%" CONTENT_ID --type Utf8 --maxsize 48 --value "%CONTENT_ID%" || goto :fail
PkgTool.Core sfo_setentry "%SFO%" DOWNLOAD_DATA_SIZE --type Integer --maxsize 4 --value 0 || goto :fail
PkgTool.Core sfo_setentry "%SFO%" FORMAT --type Utf8 --maxsize 4 --value "obs" || goto :fail
PkgTool.Core sfo_setentry "%SFO%" PARENTAL_LEVEL --type Integer --maxsize 4 --value 0 || goto :fail
PkgTool.Core sfo_setentry "%SFO%" SYSTEM_VER --type Integer --maxsize 4 --value %SYSTEM_VER% || goto :fail
PkgTool.Core sfo_setentry "%SFO%" TITLE --type Utf8 --maxsize 128 --value "%APP_NAME%" || goto :fail
PkgTool.Core sfo_setentry "%SFO%" TITLE_ID --type Utf8 --maxsize 12 --value "%TITLE_ID%" || goto :fail
PkgTool.Core sfo_setentry "%SFO%" VERSION --type Utf8 --maxsize 8 --value "%APP_VERSION%" || goto :fail

echo.
echo === 4/5 eboot.bin ===
create-fself -in="%OUT%\eboot.elf" -out="%OUT%\eboot.oelf" --eboot "%OUT%\pkg\eboot.bin" --paid 0x3800000000000011
if errorlevel 1 goto :fail

echo.
echo === 4 bis/5 updater.elf ===
clang++ --target=x86_64-pc-freebsd12-elf -std=gnu++17 -O2 -fno-exceptions -fPIC -funwind-tables -c ^
  -isysroot "%TC%" -isystem "%TC%\include" -isystem "%TC%\include\c++\v1" ^
  updater\updater.cpp -o "%OUT%\obj\updater.o"
if errorlevel 1 goto :fail
ld.lld -m elf_x86_64 -pie --script "%TC%\link.x" --eh-frame-hdr -o "%OUT%\updater.elf" ^
  "%OUT%\obj\updater.o" -L"%TC%\lib" -lc -lkernel -lSceSystemService -lSceUserService -lSceAppInstUtil -lSceSysmodule ^
  "%TC%\lib\crt1.o"
if errorlevel 1 goto :fail
create-fself -in="%OUT%\updater.elf" -out="%OUT%\updater.oelf" --eboot "%OUT%\pkg\assets\misc\updater.elf" --paid 0x3800000000000011
if errorlevel 1 goto :fail

copy /y "sce_sys\icon0.png" "%OUT%\pkg\sce_sys\icon0.png" >nul || goto :fail
copy /y "assets\fonts\font.ttf" "%OUT%\pkg\assets\fonts\font.ttf" >nul || goto :fail
for %%L in (fr en es) do copy /y "assets\locales\%%L.json" "%OUT%\pkg\assets\misc\%%L.json" >nul || goto :fail
copy /y "%MODDIR%\libc.prx" "%OUT%\pkg\sce_module\libc.prx" >nul || goto :fail
copy /y "%MODDIR%\libSceFios2.prx" "%OUT%\pkg\sce_module\libSceFios2.prx" >nul || goto :fail
set "FILES=eboot.bin sce_sys/param.sfo sce_sys/icon0.png sce_module/libc.prx sce_module/libSceFios2.prx assets/fonts/font.ttf assets/misc/fr.json assets/misc/en.json assets/misc/es.json assets/misc/updater.elf"
if defined RIGHT (
  copy /y "%RIGHT%" "%OUT%\pkg\sce_sys\about\right.sprx" >nul || goto :fail
  set "FILES=!FILES! sce_sys/about/right.sprx"
)

echo.
echo === 5/5 PS4Store.pkg ===
pushd "%OUT%\pkg"
create-gp4 -out "pkg.gp4" --content-id="%CONTENT_ID%" --files "!FILES!"
if errorlevel 1 ( popd & goto :fail )
PkgTool.Core pkg_build pkg.gp4 ..
if errorlevel 1 ( popd & goto :fail )
popd

set "PKG="
for %%P in ("%OUT%\*.pkg") do set "PKG=%%P"
if not defined PKG ( echo [ERREUR] Aucun .pkg genere. & goto :fail )
copy /y "!PKG!" "PS4Store.pkg" >nul || goto :fail
if exist "..\server\public\store" copy /y "PS4Store.pkg" "..\server\public\store\PS4Store.pkg" >nul

echo.
echo [OK] PS4Store.pkg genere.
if exist "..\server\public\store\PS4Store.pkg" echo      Copie aussi dans server\public\store\
endlocal
exit /b 0

:fail
echo.
echo [ECHEC] La compilation s'est arretee.
endlocal
exit /b 1
