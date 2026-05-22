@echo off
setlocal

cd /d "%~dp0"

echo Building auditor64...
if not exist "%~dp0node_modules\chess.js" (
    echo Installing Node dependencies...
    call npm install --omit=dev
    if errorlevel 1 (
        echo.
        echo npm install failed.
        exit /b 1
    )
)

call mvn clean package
if errorlevel 1 (
    echo.
    echo Build failed.
    exit /b 1
)

set "DIST_DIR=%~dp0dist"
set "TARGET_DIST=%~dp0target\dist"

if exist "%DIST_DIR%" rmdir /s /q "%DIST_DIR%"
mkdir "%DIST_DIR%"
mkdir "%DIST_DIR%\lib"
mkdir "%DIST_DIR%\scripts"
mkdir "%DIST_DIR%\node_modules"

copy /y "%~dp0target\auditor64-1.0.0.jar" "%DIST_DIR%\auditor64.jar" >nul
if errorlevel 1 (
    echo Failed to copy auditor64.jar.
    exit /b 1
)

xcopy /y /i "%TARGET_DIST%\lib\*.jar" "%DIST_DIR%\lib\" >nul
if errorlevel 1 (
    echo Failed to copy runtime libraries.
    exit /b 1
)

xcopy /y /i "%~dp0scripts\*.js" "%DIST_DIR%\scripts\" >nul
if errorlevel 1 (
    echo Failed to copy audit scripts.
    exit /b 1
)

xcopy /y /i /e "%~dp0node_modules\chess.js" "%DIST_DIR%\node_modules\chess.js\" >nul
if errorlevel 1 (
    echo Failed to copy Node dependencies.
    exit /b 1
)

copy /y "%~dp0package.json" "%DIST_DIR%\package.json" >nul
if exist "%~dp0package-lock.json" copy /y "%~dp0package-lock.json" "%DIST_DIR%\package-lock.json" >nul

(
    echo @echo off
    echo cd /d "%%~dp0"
    echo java -jar auditor64.jar
) > "%DIST_DIR%\run-auditor64.bat"

echo.
echo Distribution created:
echo   %DIST_DIR%
echo.
echo Start with:
echo   %DIST_DIR%\run-auditor64.bat
echo or:
echo   java -jar "%DIST_DIR%\auditor64.jar"

endlocal
