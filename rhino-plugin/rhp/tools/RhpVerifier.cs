// Inspects a built .rhp WITHOUT loading it: PE/metadata level verification.
using System;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Reflection;
using System.Security.Cryptography;

class Program
{
    static int fails = 0;
    static void Check(string name, bool ok, string detail = "")
    {
        Console.WriteLine((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   [" + detail + "]"));
        if (!ok) fails++;
    }

    static int Main(string[] args)
    {
        // defaults match the normal project layout: run it right after a build
        string rhp = args.Length > 0 ? args[0]
            : Path.GetFullPath(Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..",
                "built", "RhinoLiveBridge.rhp"));
        string pySource = args.Length > 1 ? args[1]
            : Path.GetFullPath(Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..",
                "..", "RhinoLiveBridge.py"));

        var bytes = File.ReadAllBytes(rhp);
        Console.WriteLine("artifact: " + rhp);
        Console.WriteLine("size    : " + bytes.Length + " bytes");
        Console.WriteLine();

        // ---- PE / CLR headers ----
        using var fs = File.OpenRead(rhp);
        using var pe = new PEReader(fs);
        Check("is a valid PE image", pe.PEHeaders != null);
        Check("has a CLR (managed) header", pe.PEHeaders.CorHeader != null);
        Check("is a DLL, not an EXE", pe.PEHeaders.CorHeader.Flags.HasFlag(
            System.Reflection.PortableExecutable.CorFlags.ILOnly));
        var cor = pe.PEHeaders.CorHeader.Flags;
        Check("runs on 64-bit Rhino (ILONLY, no 32BITREQUIRED)",
              cor.HasFlag(CorFlags.ILOnly) && !cor.HasFlag(CorFlags.Requires32Bit),
              cor.ToString());

        var md = pe.GetMetadataReader();

        // ---- assembly identity ----
        var asm = md.GetAssemblyDefinition();
        string asmName = md.GetString(asm.Name);
        string asmVersion = asm.Version.ToString();
        Check("assembly name is RhinoLiveBridge", asmName == "RhinoLiveBridge", asmName);
        Check("assembly version is 2.6.4.0", asmVersion.StartsWith("2.6.4"), asmVersion);

        // ---- references ----
        var refs = md.AssemblyReferences.Select(h => md.GetString(md.GetAssemblyReference(h).Name)).ToList();
        Check("references RhinoCommon", refs.Any(r => r.Equals("RhinoCommon", StringComparison.OrdinalIgnoreCase)),
              string.Join(", ", refs));
        Check("references mscorlib/.NET Framework", refs.Any(r => r == "mscorlib" || r == "System.Runtime"),
              string.Join(", ", refs));

        // ---- types ----
        var typeNames = md.TypeDefinitions
            .Select(h => md.GetString(md.GetTypeDefinition(h).Namespace) + "." +
                         md.GetString(md.GetTypeDefinition(h).Name))
            .ToList();
        Check("contains the plugin class",
              typeNames.Contains("RhinoLiveBridge.RhinoLiveBridgePlugIn"),
              string.Join(", ", typeNames.Where(t => t.StartsWith("RhinoLiveBridge"))));
        Check("contains the RhinoLiveBridge command",
              typeNames.Contains("RhinoLiveBridge.RhinoLiveBridgeCommand"));
        Check("contains the stop command",
              typeNames.Contains("RhinoLiveBridge.RhinoLiveBridgeStopCommand"));
        Check("contains the status command",
              typeNames.Contains("RhinoLiveBridge.RhinoLiveBridgeStatusCommand"));

        // ---- embedded python bridge ----
        var resources = md.ManifestResources
            .Select(h => md.GetString(md.GetManifestResource(h).Name)).ToList();
        Check("embeds the python bridge as a resource",
              resources.Contains("RhinoLiveBridge.RhinoLiveBridge.py"),
              string.Join(", ", resources));

        bool resourceMatches = false;
        string hashInfo = "";
        foreach (var handle in md.ManifestResources)
        {
            var res = md.GetManifestResource(handle);
            if (md.GetString(res.Name) != "RhinoLiveBridge.RhinoLiveBridge.py") continue;
            // resource blob = 4 byte length prefix + payload
            var dir = pe.PEHeaders.CorHeader.ResourcesDirectory;
            var block = pe.GetSectionData(dir.RelativeVirtualAddress);
            int offset = (int)res.Offset;
            int len = block.GetReader(offset, 4).ReadInt32();
            var reader2 = block.GetReader(offset + 4, len);
            var payload = reader2.ReadBytes(len);
            var src = File.ReadAllBytes(pySource);
            string hashEmbedded = Convert.ToHexString(SHA256.HashData(payload));
            string hashSource = Convert.ToHexString(SHA256.HashData(src));
            resourceMatches = hashEmbedded == hashSource;
            hashInfo = "embedded " + payload.Length + "B / source " + src.Length + "B";
        }
        Check("embedded bridge is byte-for-byte the current RhinoLiveBridge.py",
              resourceMatches, hashInfo);

        // ---- method level sanity ----
        bool hasOnLoad = false, hasLoadTime = false, hasRunCommand = false;
        foreach (var th in md.TypeDefinitions)
        {
            var td = md.GetTypeDefinition(th);
            string tn = md.GetString(td.Name);
            foreach (var mh in td.GetMethods())
            {
                string mn = md.GetString(md.GetMethodDefinition(mh).Name);
                if (tn == "RhinoLiveBridgePlugIn" && mn == "OnLoad") hasOnLoad = true;
                if (tn == "RhinoLiveBridgePlugIn" && mn == "get_LoadTime") hasLoadTime = true;
                if (tn.EndsWith("Command") && mn == "RunCommand") hasRunCommand = true;
            }
        }
        Check("plugin implements OnLoad", hasOnLoad);
        Check("plugin overrides LoadTime (auto start)", hasLoadTime);
        Check("commands implement RunCommand", hasRunCommand);

        // ---- what Rhino itself looks at when loading a .rhp ----
        string BaseTypeName(string typeName)
        {
            foreach (var h in md.TypeDefinitions)
            {
                var td = md.GetTypeDefinition(h);
                if (md.GetString(td.Name) != typeName) continue;
                if (td.BaseType.Kind == HandleKind.TypeReference)
                {
                    var tr = md.GetTypeReference((TypeReferenceHandle)td.BaseType);
                    return md.GetString(tr.Namespace) + "." + md.GetString(tr.Name);
                }
                return "(local/" + td.BaseType.Kind + ")";
            }
            return "(missing)";
        }

        bool HasAttributeNamed(string typeName, string attrSimpleName)
        {
            foreach (var h in md.TypeDefinitions)
            {
                var td = md.GetTypeDefinition(h);
                if (md.GetString(td.Name) != typeName) continue;
                foreach (var ah in td.GetCustomAttributes())
                {
                    var ca = md.GetCustomAttribute(ah);
                    if (ca.Constructor.Kind != HandleKind.MemberReference) continue;
                    var mr = md.GetMemberReference((MemberReferenceHandle)ca.Constructor);
                    if (mr.Parent.Kind != HandleKind.TypeReference) continue;
                    var tr = md.GetTypeReference((TypeReferenceHandle)mr.Parent);
                    if (md.GetString(tr.Name) == attrSimpleName) return true;
                }
            }
            return false;
        }

        bool IsOverride(string typeName, string methodName)
        {
            foreach (var h in md.TypeDefinitions)
            {
                var td = md.GetTypeDefinition(h);
                if (md.GetString(td.Name) != typeName) continue;
                foreach (var mh in td.GetMethods())
                {
                    var m = md.GetMethodDefinition(mh);
                    if (md.GetString(m.Name) != methodName) continue;
                    bool virt = m.Attributes.HasFlag(MethodAttributes.Virtual);
                    bool newslot = m.Attributes.HasFlag(MethodAttributes.NewSlot);
                    return virt && !newslot;   // true override, not a shadow
                }
            }
            return false;
        }

        Check("plugin derives from Rhino.PlugIns.PlugIn",
              BaseTypeName("RhinoLiveBridgePlugIn") == "Rhino.PlugIns.PlugIn",
              BaseTypeName("RhinoLiveBridgePlugIn"));
        Check("plugin carries a [Guid] attribute (Rhino requires it)",
              HasAttributeNamed("RhinoLiveBridgePlugIn", "GuidAttribute"));
        Check("RhinoLiveBridge command is a real Command",
              BaseTypeName("RhinoLiveBridgeCommand") == "Rhino.Commands.Command");
        Check("stop command is a real Command",
              BaseTypeName("RhinoLiveBridgeStopCommand") == "Rhino.Commands.Command");
        Check("status command is a real Command",
              BaseTypeName("RhinoLiveBridgeStatusCommand") == "Rhino.Commands.Command");
        Check("OnLoad is a true override of PlugIn.OnLoad (not a shadow)",
              IsOverride("RhinoLiveBridgePlugIn", "OnLoad"));
        Check("LoadTime is a true override (this is what auto starts the bridge)",
              IsOverride("RhinoLiveBridgePlugIn", "get_LoadTime"));
        Check("RunCommand is a true override in the commands",
              IsOverride("RhinoLiveBridgeCommand", "RunCommand"));
        Check("command has its own [Guid]",
              HasAttributeNamed("RhinoLiveBridgeCommand", "GuidAttribute"));

        Console.WriteLine();
        Console.WriteLine(fails == 0 ? "RHP VERIFICATION: ALL PASSED" : "RHP VERIFICATION FAILURES: " + fails);
        return fails == 0 ? 0 : 1;
    }
}
