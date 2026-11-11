#!/bin/bash
# ================================================================
#   Rhino Live Bridge - build the Rhino plugin (.rhp)
#   Version 2.6.4
#
#   Use this on macOS (Rhino 8 for Mac) or Linux.
#   On Windows just double click build_rhp.bat instead.
# ================================================================
set -u
cd "$(dirname "$0")"

echo "================================================================"
echo "  Rhino Live Bridge - build the Rhino plugin (.rhp)"
echo "================================================================"
echo

# ---------- 1) the bridge python file must be one level up ----------
if [ ! -f "../RhinoLiveBridge.py" ]; then
    echo "[FAIL] ../RhinoLiveBridge.py was not found."
    echo "       Keep this folder layout:"
    echo "           rhino-plugin/RhinoLiveBridge.py     (the bridge)"
    echo "           rhino-plugin/rhp/build_rhp.sh       (this script)"
    exit 1
fi
echo "[ok] found the bridge: ../RhinoLiveBridge.py"

# ---------- 2) a .NET SDK is required to compile ----------
if ! command -v dotnet >/dev/null 2>&1; then
    echo
    echo "[FAIL] the .NET SDK was not found on this machine."
    echo "       Install it once from https://dotnet.microsoft.com/download"
    echo "       On macOS with Homebrew:  brew install --cask dotnet-sdk"
    echo
    echo "       If you only want to USE the plugin you do not have to build:"
    echo "       built/RhinoLiveBridge.rhp is the Windows build (prebuilt)."
    exit 1
fi
echo "[ok] .NET SDK found: $(dotnet --version)"
echo

# ---------- 3) pick the target for this machine ----------
# macOS Rhino 8 runs on .NET 7 -> net7.0.  Windows Rhino 7/8 -> net48.
case "$(uname -s)" in
    Darwin) TARGET="net7.0" ;;
    *)      TARGET="net48" ;;
esac
echo "Target framework: $TARGET"
echo

# ---------- 4) build ----------
echo "Compiling... (the first run downloads RhinoCommon from NuGet)"
echo
dotnet build RhinoLiveBridge.csproj -c Release -p:RhinoTarget="$TARGET"
if [ $? -ne 0 ]; then
    echo
    echo "[FAIL] the build did not finish. The errors above say why."
    echo "       Most common cause: no internet on the first build."
    exit 1
fi

echo
echo "================================================================"
echo "  DONE"
echo "================================================================"
echo "  Plugin file:  $(pwd)/built/RhinoLiveBridge.rhp"
echo
echo "  Install it in Rhino (once):"
echo "      1. open Rhino"
echo "      2. run the command:  PluginManager"
echo "      3. press Install... and pick built/RhinoLiveBridge.rhp"
echo "      4. restart Rhino"
echo
echo "  After that the bridge starts by itself with Rhino - no server"
echo "  window to keep open."
echo
echo "  Optional - prove the built file is a valid plugin:"
echo "      dotnet run --project tools/RhpVerifier.csproj -c Release"
echo "================================================================"
