using System.Net.NetworkInformation;
using Microsoft.Win32;

namespace Swir.Desktop.Host;

internal sealed class DesktopDeviceNetworkBroker
{
    private const int MaxDevices = 512;
    private static readonly string[] DeviceBuses = ["PCI", "USB"];

    public object Describe() => new
    {
        schema = "swir.desktop-device-network/0.1",
        provider = "windows-native",
        native = OperatingSystem.IsWindows(),
        readOnly = true,
        networkMutation = false,
        deviceMutation = false,
        privacy = new
        {
            exposesMacAddresses = false,
            exposesIpAddresses = false,
            exposesWifiCredentials = false
        },
        capabilities = new[] { "network.status", "network.adapters", "devices.list" }
    };

    public object NetworkStatus()
    {
        var adapters = GetNetworkAdapters();
        return new
        {
            schema = "swir.desktop-network-status/0.1",
            provider = "windows-native",
            online = NetworkInterface.GetIsNetworkAvailable(),
            adapterCount = adapters.Length,
            connectedAdapterCount = adapters.Count(x => x.OperationalStatus == OperationalStatus.Up.ToString()),
            adaptersUp = adapters.Count(x => x.OperationalStatus == OperationalStatus.Up.ToString()),
            readOnly = true
        };
    }

    public NetworkAdapterSnapshot[] GetNetworkAdapters()
    {
        try
        {
            return NetworkInterface.GetAllNetworkInterfaces()
                .OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase)
                .Select(ToSnapshot)
                .ToArray();
        }
        catch (NetworkInformationException ex)
        {
            throw new DeviceNetworkBrokerException("NETWORK_ENUMERATION_FAILED", ex.Message, ex);
        }
    }

    public object NetworkAdapters() => new
    {
        schema = "swir.desktop-network-adapters/0.1",
        provider = "windows-native",
        readOnly = true,
        adapters = GetNetworkAdapters()
    };

    public object Devices()
    {
        var devices = OperatingSystem.IsWindows() ? EnumerateWindowsDevices().Take(MaxDevices).ToArray() : Array.Empty<DeviceSnapshot>();
        return new
        {
            schema = "swir.desktop-devices/0.1",
            provider = "windows-native",
            supported = OperatingSystem.IsWindows(),
            readOnly = true,
            truncated = devices.Length >= MaxDevices,
            count = devices.Length,
            devices
        };
    }

    private static NetworkAdapterSnapshot ToSnapshot(NetworkInterface adapter)
    {
        IPInterfaceProperties? properties = null;
        try { properties = adapter.GetIPProperties(); } catch (NetworkInformationException) { }

        var ipv4 = false;
        var ipv6 = false;
        try { ipv4 = adapter.Supports(NetworkInterfaceComponent.IPv4); } catch { }
        try { ipv6 = adapter.Supports(NetworkInterfaceComponent.IPv6); } catch { }

        return new NetworkAdapterSnapshot(
            adapter.Id,
            adapter.Name,
            adapter.Description,
            adapter.NetworkInterfaceType.ToString(),
            adapter.OperationalStatus.ToString(),
            adapter.Speed > 0 ? Math.Round(adapter.Speed / 1_000_000d, 2) : null,
            ipv4,
            ipv6,
            properties?.UnicastAddresses.Count ?? 0,
            properties?.GatewayAddresses.Count ?? 0,
            properties?.DnsAddresses.Count ?? 0);
    }

    private static IEnumerable<DeviceSnapshot> EnumerateWindowsDevices()
    {
        foreach (var bus in DeviceBuses)
        {
            using var busKey = Registry.LocalMachine.OpenSubKey($"SYSTEM\\CurrentControlSet\\Enum\\{bus}", writable: false);
            if (busKey is null) continue;

            foreach (var deviceId in SafeNames(busKey))
            {
                using var deviceKey = busKey.OpenSubKey(deviceId, writable: false);
                if (deviceKey is null) continue;

                foreach (var instanceId in SafeNames(deviceKey))
                {
                    using var instanceKey = deviceKey.OpenSubKey(instanceId, writable: false);
                    if (instanceKey is null) continue;

                    var className = ReadString(instanceKey, "Class");
                    var service = ReadString(instanceKey, "Service");
                    var description = NormalizeRegistryDisplayName(ReadString(instanceKey, "FriendlyName") ?? ReadString(instanceKey, "DeviceDesc"));
                    var manufacturer = NormalizeRegistryDisplayName(ReadString(instanceKey, "Mfg"));
                    var problem = ReadInt(instanceKey, "Problem");
                    var configFlags = ReadInt(instanceKey, "ConfigFlags");

                    yield return new DeviceSnapshot(
                        bus.ToLowerInvariant(),
                        deviceId,
                        instanceId,
                        description,
                        className,
                        manufacturer,
                        service,
                        problem,
                        configFlags,
                        problem is null or 0);
                }
            }
        }
    }

    private static string[] SafeNames(RegistryKey key)
    {
        try { return key.GetSubKeyNames(); }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or System.Security.SecurityException) { return Array.Empty<string>(); }
    }

    private static string? ReadString(RegistryKey key, string name)
    {
        try { return key.GetValue(name) as string; }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or System.Security.SecurityException) { return null; }
    }

    private static int? ReadInt(RegistryKey key, string name)
    {
        try
        {
            var value = key.GetValue(name);
            return value switch
            {
                int number => number,
                long number when number is >= int.MinValue and <= int.MaxValue => (int)number,
                _ => null
            };
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or System.Security.SecurityException) { return null; }
    }

    private static string? NormalizeRegistryDisplayName(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim();
        var separator = trimmed.LastIndexOf(';');
        return separator >= 0 && separator + 1 < trimmed.Length ? trimmed[(separator + 1)..].Trim() : trimmed;
    }

    internal sealed record NetworkAdapterSnapshot(
        string Id,
        string Name,
        string Description,
        string Type,
        string OperationalStatus,
        double? SpeedMbps,
        bool SupportsIpv4,
        bool SupportsIpv6,
        int UnicastAddressCount,
        int GatewayCount,
        int DnsServerCount);

    internal sealed record DeviceSnapshot(
        string Bus,
        string HardwareId,
        string InstanceId,
        string? Description,
        string? ClassName,
        string? Manufacturer,
        string? Service,
        int? ProblemCode,
        int? ConfigFlags,
        bool Healthy);
}

internal sealed class DeviceNetworkBrokerException(string code, string message, Exception? inner = null) : Exception(message, inner)
{
    public string Code { get; } = code;
}
