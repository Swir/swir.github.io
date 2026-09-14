using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopProcessServiceBrokerSelfTests
{
    public static int Main()
    {
        try
        {
            var broker = new DesktopProcessServiceBroker();
            var json = JsonSerializer.Serialize(broker.Describe(), new JsonSerializerOptions(JsonSerializerDefaults.Web));
            Require(json.Contains("swir.desktop-process-service/0.1", StringComparison.Ordinal), "schema missing");
            Require(json.Contains("\"readOnly\":true", StringComparison.Ordinal), "broker must stay read-only");
            foreach (var forbidden in new[] { "commandLine", "executablePath", "environmentVariables", "password", "credential", "token" })
                Require(!json.Contains($"\"{forbidden}\"", StringComparison.OrdinalIgnoreCase), $"forbidden field exposed: {forbidden}");

            var processes = broker.GetProcesses();
            Require(processes.Length > 0, "process inventory is empty");
            Require(processes.Any(p => p.Pid == Environment.ProcessId), "self process missing from inventory");
            Require(processes.All(p => p.Pid > 0 && !string.IsNullOrWhiteSpace(p.Name)), "invalid process snapshot");

            var services = broker.GetServices();
            if (OperatingSystem.IsWindows())
                Require(services.All(s => !string.IsNullOrWhiteSpace(s.Name) && !string.IsNullOrWhiteSpace(s.DisplayName)), "invalid service snapshot");

            Console.WriteLine($"Desktop process/service broker self-test passed. processes={processes.Length} services={services.Length}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
