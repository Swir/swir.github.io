using System.Diagnostics;
using Microsoft.Win32;

namespace Swir.Desktop.Host;

internal sealed class DesktopProcessServiceBroker
{
    private const int MaxProcesses = 512;
    private const int MaxServices = 1024;

    public object Describe() => new
    {
        schema = "swir.desktop-process-service/0.1",
        platform = "windows",
        readOnly = true,
        processMutation = false,
        serviceMutation = false,
        commandLineExposure = false,
        executablePathExposure = false,
        environmentExposure = false,
        processCount = GetProcesses().Length,
        serviceCount = GetServices().Length
    };

    public ProcessSnapshot[] GetProcesses()
    {
        var result = new List<ProcessSnapshot>();
        foreach (var process in Process.GetProcesses().OrderBy(p => p.Id).Take(MaxProcesses))
        {
            using (process)
            {
                try
                {
                    var memory = Safe(() => process.WorkingSet64, 0L);
                    var started = Safe<DateTime?>(() => process.StartTime.ToUniversalTime(), null);
                    var responding = Safe<bool?>(() => process.Responding, null);
                    result.Add(new ProcessSnapshot(
                        process.Id,
                        Safe(() => process.ProcessName, "unknown"),
                        process.Id == Environment.ProcessId,
                        memory,
                        started,
                        responding));
                }
                catch { }
            }
        }
        return result.ToArray();
    }

    public ServiceSnapshot[] GetServices()
    {
        if (!OperatingSystem.IsWindows()) return Array.Empty<ServiceSnapshot>();
        var result = new List<ServiceSnapshot>();
        using var root = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services", writable: false);
        if (root is null) return Array.Empty<ServiceSnapshot>();

        foreach (var serviceName in root.GetSubKeyNames().OrderBy(x => x, StringComparer.OrdinalIgnoreCase).Take(MaxServices))
        {
            try
            {
                using var key = root.OpenSubKey(serviceName, writable: false);
                if (key is null) continue;
                var type = ConvertToInt(key.GetValue("Type"));
                if (!IsUserModeService(type)) continue;
                var start = ConvertToInt(key.GetValue("Start"));
                var displayName = key.GetValue("DisplayName") as string;
                result.Add(new ServiceSnapshot(
                    serviceName,
                    string.IsNullOrWhiteSpace(displayName) ? serviceName : displayName,
                    ServiceType(type),
                    StartMode(start),
                    key.GetValue("ObjectName") is string account && !string.IsNullOrWhiteSpace(account) ? "configured" : "unspecified"));
            }
            catch { }
        }
        return result.ToArray();
    }

    private static bool IsUserModeService(int type) => (type & 0x10) != 0 || (type & 0x20) != 0;
    private static string ServiceType(int type) => (type & 0x20) != 0 ? "shared-process" : "own-process";
    private static string StartMode(int start) => start switch { 0 => "boot", 1 => "system", 2 => "automatic", 3 => "manual", 4 => "disabled", _ => "unknown" };
    private static int ConvertToInt(object? value) { try { return Convert.ToInt32(value); } catch { return -1; } }
    private static T Safe<T>(Func<T> read, T fallback) { try { return read(); } catch { return fallback; } }

    internal sealed record ProcessSnapshot(int Pid, string Name, bool IsHost, long WorkingSetBytes, DateTime? StartedUtc, bool? Responding);
    internal sealed record ServiceSnapshot(string Name, string DisplayName, string Type, string StartMode, string AccountConfiguration);
}
