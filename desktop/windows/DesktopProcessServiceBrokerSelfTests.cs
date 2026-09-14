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
            Require(json.Contains("\"processMutation\":false", StringComparison.Ordinal), "process mutation must stay disabled");
            Require(json.Contains("\"serviceMutation\":false", StringComparison.Ordinal), "service mutation must stay disabled");
            foreach (var forbidden in new[] { "commandLine", "executablePath", "environmentVariables", "password", "credential", "token" })
                Require(!json.Contains($"\"{forbidden}\"", StringComparison.OrdinalIgnoreCase), $"forbidden field exposed: {forbidden}");

            var processes = broker.GetProcesses();
            Require(processes.Length > 0, "process inventory is empty");
            Require(processes.Length <= 512, "process inventory exceeds contract limit");
            Require(processes.Any(p => p.Pid == Environment.ProcessId && p.IsHost), "self process missing from inventory");
            var invalidProcess = processes.FirstOrDefault(p => p.Pid <= 0 || string.IsNullOrWhiteSpace(p.Name) || p.WorkingSetBytes < 0);
            Require(invalidProcess is null, invalidProcess is null ? "invalid process snapshot" : $"invalid process snapshot: pid={invalidProcess.Pid} name={invalidProcess.Name} memory={invalidProcess.WorkingSetBytes}");

            var services = broker.GetServices();
            Require(services.Length <= 1024, "service inventory exceeds contract limit");
            if (OperatingSystem.IsWindows())
            {
                var invalidService = services.FirstOrDefault(s => string.IsNullOrWhiteSpace(s.Name) || string.IsNullOrWhiteSpace(s.DisplayName));
                Require(invalidService is null, invalidService is null ? "invalid service snapshot" : $"invalid service snapshot: name={invalidService.Name} display={invalidService.DisplayName}");
            }

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
