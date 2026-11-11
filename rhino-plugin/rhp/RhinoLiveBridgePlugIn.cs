// ================================================================
//  RHINO LIVE BRIDGE - RHINO PLUGIN (.rhp)
//  Version: 2.6.4  |  Designer: Reza Khoshnood
// ----------------------------------------------------------------
//  This is a real RhinoCommon plugin. Once installed in Rhino it
//  loads at startup and starts the whole bridge by itself:
//
//    Rhino starts
//        -> OnLoad() extracts the bundled Python bridge to
//           %APPDATA%\RhinoLiveBridge\ and runs it inside Rhino
//        -> the bridge opens http://127.0.0.1:8765 (no extra app,
//           no console window, no separate server to keep alive)
//        -> the Chrome extension finds it and streams code in
//
//  Commands added to Rhino:
//    RhinoLiveBridge        - start / restart the bridge
//    RhinoLiveBridgeStop    - stop the bridge
//    RhinoLiveBridgeStatus  - print the current state
//
//  The Python bridge itself (RhinoLiveBridge.py) is embedded in this
//  assembly as a resource, so a single .rhp file is all that has to
//  be distributed.
// ================================================================

using System;
using System.IO;
using System.Reflection;
using System.Text;
using Rhino;
using Rhino.Commands;
using Rhino.PlugIns;

namespace RhinoLiveBridge
{
    /// <summary>
    /// The plugin entry point. Rhino loads it at startup
    /// (PlugInLoadTime.AtStartup) and the bridge comes up with it.
    /// </summary>
    [System.Runtime.InteropServices.Guid("6F1B0B6C-2D5A-4E7B-9C3A-5D7E8F1A2B3C")]
    public class RhinoLiveBridgePlugIn : PlugIn
    {
        private const string ResourceName = "RhinoLiveBridge.RhinoLiveBridge.py";
        private const string ScriptFileName = "RhinoLiveBridge.py";
        private static bool _started;
        private static string _lastError = "";
        private static int _startCount;

        public RhinoLiveBridgePlugIn()
        {
            Instance = this;
        }

        public static RhinoLiveBridgePlugIn Instance { get; private set; }

        /// <summary>Load as soon as Rhino starts, without any user action.</summary>
        public override PlugInLoadTime LoadTime
        {
            get { return PlugInLoadTime.AtStartup; }
        }

        public static string LastError
        {
            get { return _lastError; }
        }

        public static bool Started
        {
            get { return _started; }
        }

        public static int StartCount
        {
            get { return _startCount; }
        }

        protected override LoadReturnCode OnLoad(ref string errorMessage)
        {
            try
            {
                // 1) make sure the python bridge exists on disk
                string scriptPath = ExtractScript();
                if (scriptPath == null)
                {
                    _lastError = "the bundled bridge script could not be written to disk";
                    RhinoApp.WriteLine("Rhino Live Bridge: " + _lastError);
                    return LoadReturnCode.Success;   // never block Rhino startup
                }

                // 2) start it once Rhino is fully ready
                HookStartup(scriptPath);
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                RhinoApp.WriteLine("Rhino Live Bridge: load error - " + ex.Message);
            }

            return LoadReturnCode.Success;
        }

        protected override void OnShutdown()
        {
            // the bridge lives in this process: nothing to clean up outside it
            RhinoApp.WriteLine("Rhino Live Bridge: Rhino is closing, bridge stopped.");
            base.OnShutdown();
        }

        // ------------------------------------------------------------
        // Resource extraction
        // ------------------------------------------------------------
        /// <summary>Write the embedded python bridge to %APPDATA% and return its path.</summary>
        public static string ExtractScript()
        {
            string folder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "RhinoLiveBridge");

            if (!Directory.Exists(folder))
            {
                Directory.CreateDirectory(folder);
            }

            string target = Path.Combine(folder, ScriptFileName);

            Assembly assembly = typeof(RhinoLiveBridgePlugIn).Assembly;
            using (Stream stream = assembly.GetManifestResourceStream(ResourceName))
            {
                if (stream == null)
                {
                    // fall back to a copy next to the .rhp (developer layout)
                    string beside = Path.Combine(
                        Path.GetDirectoryName(assembly.Location) ?? folder, ScriptFileName);
                    if (File.Exists(beside))
                    {
                        File.Copy(beside, target, true);
                        return target;
                    }
                    return null;
                }

                // always refresh, so upgrading the .rhp upgrades the bridge
                using (FileStream file = new FileStream(target, FileMode.Create, FileAccess.Write))
                {
                    byte[] buffer = new byte[8192];
                    int read;
                    while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        file.Write(buffer, 0, read);
                    }
                }
            }

            return target;
        }

        // ------------------------------------------------------------
        // Starting the python side
        // ------------------------------------------------------------
        private static void HookStartup(string scriptPath)
        {
            // Preferred: Rhino tells us when it finished initialising.
            try
            {
                RhinoApp.Initialized += delegate { StartBridge(scriptPath); };
            }
            catch (Exception)
            {
                // event may not exist on very old builds: fall through
            }

            // Fallback: a one shot idle handler, in case Initialized already
            // fired before the plugin was loaded.
            EventHandler idleFallback = null;
            idleFallback = delegate
            {
                try
                {
                    RhinoApp.Idle -= idleFallback;   // one shot
                }
                catch (Exception)
                {
                    // already detached
                }
                StartBridge(scriptPath);
            };
            try
            {
                RhinoApp.Idle += idleFallback;
            }
            catch (Exception)
            {
                StartBridge(scriptPath);
            }
        }

        /// <summary>Run the python bridge inside Rhino (idempotent).</summary>
        public static bool StartBridge(string scriptPath)
        {
            if (_started)
            {
                return true;
            }
            if (string.IsNullOrEmpty(scriptPath))
            {
                scriptPath = ExtractScript();
            }
            if (string.IsNullOrEmpty(scriptPath))
            {
                _lastError = "bridge script not found";
                return false;
            }

            string macro = "_-RunPythonScript \"" + scriptPath + "\"";
            try
            {
                RhinoApp.RunScript(macro, false);
                _started = true;
                _startCount++;
                _lastError = "";
                RhinoApp.WriteLine("Rhino Live Bridge: bridge started in this Rhino session.");
                return true;
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                RhinoApp.WriteLine("Rhino Live Bridge: could not start - " + ex.Message);
                return false;
            }
        }

        /// <summary>Run the bridge with the --stop argument.</summary>
        public static bool StopBridge()
        {
            string scriptPath = ExtractScript();
            if (string.IsNullOrEmpty(scriptPath))
            {
                return false;
            }
            try
            {
                RhinoApp.RunScript("_-RunPythonScript \"" + scriptPath + "\" --stop", false);
                _started = false;
                RhinoApp.WriteLine("Rhino Live Bridge: stop requested.");
                return true;
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                return false;
            }
        }

        public static string StatusText()
        {
            StringBuilder builder = new StringBuilder();
            builder.AppendLine("Rhino Live Bridge 2.6.4");
            builder.AppendLine("  bridge started : " + (_started ? "yes" : "no"));
            builder.AppendLine("  starts so far  : " + _startCount);
            builder.AppendLine("  address        : http://127.0.0.1:8765");
            builder.AppendLine("  live viewport  : /viewport (JPEG frames of the active view)");
            builder.AppendLine("  verification   : /verify + automatic repair + /retry loop");
            builder.AppendLine("  script folder  : " + Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "RhinoLiveBridge"));
            if (!string.IsNullOrEmpty(_lastError))
            {
                builder.AppendLine("  last error     : " + _lastError);
            }
            return builder.ToString();
        }
    }

    // ================================================================
    //  RhinoLiveBridge command
    // ================================================================
    [System.Runtime.InteropServices.Guid("7A2C1D4E-3B6F-4C8D-8E9F-0A1B2C3D4E5F")]
    public class RhinoLiveBridgeCommand : Command
    {
        public override string EnglishName
        {
            get { return "RhinoLiveBridge"; }
        }

        protected override Result RunCommand(RhinoDoc doc, RunMode mode)
        {
            if (RhinoLiveBridgePlugIn.Started)
            {
                RhinoApp.WriteLine("Rhino Live Bridge is already running.");
                RhinoApp.WriteLine(RhinoLiveBridgePlugIn.StatusText());
                return Result.Success;
            }

            bool ok = RhinoLiveBridgePlugIn.StartBridge(null);
            RhinoApp.WriteLine(ok
                ? "Rhino Live Bridge started. Open your AI chat in Chrome and send code."
                : "Rhino Live Bridge could not start: " + RhinoLiveBridgePlugIn.LastError);
            return ok ? Result.Success : Result.Failure;
        }
    }

    // ================================================================
    //  RhinoLiveBridgeStop command
    // ================================================================
    [System.Runtime.InteropServices.Guid("8B3D2E5F-4C7A-4D9E-9F0A-1B2C3D4E5F6A")]
    public class RhinoLiveBridgeStopCommand : Command
    {
        public override string EnglishName
        {
            get { return "RhinoLiveBridgeStop"; }
        }

        protected override Result RunCommand(RhinoDoc doc, RunMode mode)
        {
            bool ok = RhinoLiveBridgePlugIn.StopBridge();
            RhinoApp.WriteLine(ok
                ? "Rhino Live Bridge stopped. Use the RhinoLiveBridge command to start it again."
                : "Rhino Live Bridge: nothing to stop.");
            return Result.Success;
        }
    }

    // ================================================================
    //  RhinoLiveBridgeStatus command
    // ================================================================
    [System.Runtime.InteropServices.Guid("9C4E3F60-5D8B-4EAF-A0B1-2C3D4E5F6A7B")]
    public class RhinoLiveBridgeStatusCommand : Command
    {
        public override string EnglishName
        {
            get { return "RhinoLiveBridgeStatus"; }
        }

        protected override Result RunCommand(RhinoDoc doc, RunMode mode)
        {
            RhinoApp.WriteLine(RhinoLiveBridgePlugIn.StatusText());
            return Result.Success;
        }
    }
}
