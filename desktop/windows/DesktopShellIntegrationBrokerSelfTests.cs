using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopShellIntegrationBrokerSelfTests
{
    [STAThread]
    private static int Main()
    {
        try
        {
            using var broker = new DesktopShellIntegrationBroker();
            var json = JsonSerializer.Serialize(broker.Describe(), new JsonSerializerOptions(JsonSerializerDefaults.Web));
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            Require(root.GetProperty("schema").GetString() == "swir.desktop-shell-integration/0.2", "unexpected schema");
            Require(root.GetProperty("machineWideWrites").GetBoolean() == false, "machine-wide writes must remain disabled");
            Require(root.GetProperty("changesDefaultApplicationWithoutUserChoice").GetBoolean() == false, "broker must not override Windows UserChoice");
            Require(root.GetProperty("windowsUserChoiceProtected").GetBoolean(), "Windows UserChoice protection must be explicit");
            Require(root.GetProperty("supportedAssociationScope").GetString() == "current-user", "association scope must remain current-user");
            Require(root.GetProperty("safeAssociationExtensions").GetArrayLength() == 5, "association allowlist must remain explicit and bounded");

            var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Process path is unavailable.");
            var plan = broker.PlanAssociation("TXT", executable);
            Require(plan.Extension == ".txt", "extension normalization failed");
            Require(plan.ProgId == "SWIR.OS_TXT", "unexpected ProgID");
            Require(plan.Scope == "current-user" && !plan.MachineWide, "association scope must be current-user only");
            Require(plan.OpenCommand.Contains("--open-file", StringComparison.Ordinal), "open command must use explicit open-file activation");
            Require(plan.OpenCommand.Contains("\"%1\"", StringComparison.Ordinal), "open command must quote the selected file");

            ExpectFailure<ArgumentException>(() => broker.PlanAssociation("../exe", executable));
            ExpectFailure<NotSupportedException>(() => broker.PlanAssociation(".exe", executable));
            ExpectFailure<NotSupportedException>(() => broker.PlanAssociation(".html", executable));
            ExpectFailure<FileNotFoundException>(() => broker.PlanAssociation(".md", Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".exe")));
            Require(!broker.TryResolveShortcut(9001, out _), "unknown shortcut must not resolve");

            broker.Dispose();
            ExpectFailure<ObjectDisposedException>(() => broker.PlanAssociation(".txt", executable));
            ExpectFailure<ObjectDisposedException>(() => broker.TryResolveShortcut(9001, out _));

            Console.WriteLine("Desktop shell integration self-tests passed.");
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

    private static void ExpectFailure<T>(Action action) where T : Exception
    {
        try { action(); }
        catch (T) { return; }
        throw new InvalidOperationException($"Expected {typeof(T).Name}.");
    }
}
