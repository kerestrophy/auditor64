@echo off
setlocal

cd /d "%~dp0"

echo Building auditor64...
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
