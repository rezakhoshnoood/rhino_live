@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ================================================================
echo   Rhino Live Bridge - build the Rhino plugin (.rhp)
echo   Version 2.6.4
echo ================================================================
echo.

REM ---------- 1) the bridge python file must be one level up ----------
if not exist "..\RhinoLiveBridge.py" (
    echo [FAIL] ..\RhinoLiveBridge.py was not found.
    echo        Keep this folder layout:
    echo            rhino-plugin\RhinoLiveBridge.py      ^(the bridge^)
    echo            rhino-plugin\rhp\build_rhp.bat        ^(this script^)
    echo.
    pause
    exit /b 1
)
echo [ok] found the bridge: ..\RhinoLiveBridge.py

REM ---------- 2) a .NET SDK is required to compile ----------
where dotnet >nul 2>nul
if errorlevel 1 (
    echo.
    echo [FAIL] the .NET SDK was not found on this machine.
    echo        Install it once from:
    echo            https://dotnet.microsoft.com/download
    echo        The free ".NET SDK" (x64) is enough - no Visual Studio needed.
    echo.
    echo        If you only want to USE the plugin, you do not have to build:
    echo        built\RhinoLiveBridge.rhp is already compiled and ready.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('dotnet --version 2^>nul') do set SDKVER=%%v
echo [ok] .NET SDK found: !SDKVER!
echo.

REM ---------- 3) build ----------
echo Compiling... (the first run downloads RhinoCommon from NuGet)
echo.
dotnet build RhinoLiveBridge.csproj -c Release -p:RhinoTarget=net48
if errorlevel 1 (
    echo.
    echo [FAIL] the build did not finish. The errors above say why.
    echo        Most common cause: no internet on the first build, so NuGet
    echo        could not download RhinoCommon.
    echo.
    pause
    exit /b 1
)

echo.
echo ================================================================
echo   DONE
echo ================================================================
echo   Plugin file:
echo       %~dp0built\RhinoLiveBridge.rhp
echo.
echo   Install it in Rhino (once):
echo       1. open Rhino
echo       2. type the command:  PluginManager
echo       3. press "Install..." and pick  built\RhinoLiveBridge.rhp
echo       4. restart Rhino
echo.
echo   That is all: from now on the bridge starts by itself whenever
echo   Rhino starts. No server window, no .bat, nothing to keep open.
echo.
echo   Commands inside Rhino:
echo       RhinoLiveBridge         start / restart the bridge
echo       RhinoLiveBridgeStop     stop it
echo       RhinoLiveBridgeStatus   show its state
echo ================================================================
echo.
pause
