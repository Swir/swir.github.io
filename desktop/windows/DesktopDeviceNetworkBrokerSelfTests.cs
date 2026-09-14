using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopDeviceNetworkBrokerSelfTests
{
    private static int Main()
    {
        try
        {
            var broker = new DesktopDeviceNetworkBroker();
            AssertSchema(broker.Describe(), "swir.desktop-device-network/0.1");
            AssertSchema(broker.NetworkStatus(), "swir.desktop-network-status/0.1");
            AssertSchema(broker.NetworkAdapters(), "swir.desktop-network-adapters/0.1");
            AssertSchema(broker.Devices(), "swir.desktop-devices/0.1");

            var serialized = JsonSerializer.Serialize(new
            {
                describe = broker.Describe(),
                network = broker.NetworkAdapters(),
                devices = broker.Devices()
            });

            foreach (var forbidden in new[] { "MacAddress", "PhysicalAddress", "IpAddress", "IpAddresses", "Ssid", "Bssid", "Password", "Credential" })
                if (serialized.Contains($"\"{forbidden}\"", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException($"Privacy regression: broker exposed forbidden field {forbidden}.");

            var adapters = broker.GetNetworkAdapters();
            if (adapters.Any(x => x.UnicastAddressCount < 0 || x.GatewayCount < 0 || x.DnsServerCount < 0))
                throw new InvalidOperationException("Network adapter counters must never be negative.");

            Console.WriteLine($"Desktop Device/Network Broker self-tests passed. adapters={adapters.Length}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
    }

    private static void AssertSchema(object value, string schema)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(value));
        if (!document.RootElement.TryGetProperty("schema", out var actual) || actual.GetString() != schema)
            throw new InvalidOperationException($"Expected schema {schema}.");
        if (!document.RootElement.TryGetProperty("readOnly", out var readOnly) || readOnly.ValueKind != JsonValueKind.True)
            throw new InvalidOperationException($"{schema} must remain read-only.");
    }
}
