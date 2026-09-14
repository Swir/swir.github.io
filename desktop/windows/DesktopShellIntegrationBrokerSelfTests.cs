using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopShellIntegrationBrokerSelfTests
{
    [STAThread]
    private static int Main()
    {
        try
        {
            TestShellIntegrationPolicy();
            TestOpenFileActivationBroker();
            Console.WriteLine("Desktop shell integration self-tests passed.");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
    }

    private static void TestShellIntegrationPolicy()
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
    }

    private static void TestOpenFileActivationBroker()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-open-file-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var textPath = Path.Combine(root, "hello world.txt");
            File.WriteAllText(textPath, "hello swir");
            var unsafePath = Path.Combine(root, "blocked.exe");
            File.WriteAllText(unsafePath, "not-an-executable");

            var broker = new DesktopOpenFileActivationBroker();
            var infoJson = JsonSerializer.Serialize(broker.Describe(), new JsonSerializerOptions(JsonSerializerDefaults.Web));
            using var infoDoc = JsonDocument.Parse(infoJson);
            var info = infoDoc.RootElement;
            Require(info.GetProperty("schema").GetString() == "swir.desktop-open-file-activation/0.2", "unexpected activation schema");
            Require(info.GetProperty("activationSwitch").GetString() == "--open-file", "activation switch drifted");
            Require(!info.GetProperty("nativePathExposure").GetBoolean(), "native paths must not be exposed to web content");
            Require(info.GetProperty("oneTimeClaim").GetBoolean(), "activation claims must remain one-time");
            Require(info.GetProperty("destinationAppBoundCapability").GetBoolean(), "claimed files must be bound to the destination app");
            Require(info.GetProperty("safeExtensions").GetArrayLength() == 5, "activation allowlist must remain bounded");

            Require(broker.CaptureCommandLine(Array.Empty<string>()) is null, "ordinary launch must not create an activation");
            var descriptor = broker.CaptureCommandLine(new[] { "--open-file", textPath })
                ?? throw new InvalidOperationException("activation was not captured");
            Require(descriptor.Name == "hello world.txt", "descriptor name mismatch");
            Require(descriptor.Extension == ".txt", "descriptor extension mismatch");
            Require(descriptor.Source == "windows-file-association", "descriptor source mismatch");
            Require(!descriptor.Id.Contains(textPath, StringComparison.OrdinalIgnoreCase), "activation id must not contain native path data");
            Require(broker.Pending().Length == 1, "activation should be pending before claim");

            string? factoryPath = null;
            string? factoryOwner = null;
            var appActivation = broker.ClaimForApplication(descriptor.Id, "swir.code", (nativePath, owner) =>
            {
                factoryPath = nativePath;
                factoryOwner = owner;
                return new { token = "test-capability", kind = "file", ownerAppId = owner };
            });
            Require(factoryPath == Path.GetFullPath(textPath), "capability factory must receive the host-only path");
            Require(factoryOwner == "swir.code", "capability must be owner-bound to the destination app");
            Require(appActivation.AppId == "swir.code", "application activation owner mismatch");
            Require(appActivation.FileCapability is not null, "application activation must include a capability descriptor");
            Require(broker.Pending().Length == 0, "claimed activation must be removed");
            ExpectFailure<InvalidOperationException>(() => broker.Claim(descriptor.Id));

            var invalidOwner = broker.CaptureFile(textPath);
            ExpectFailure<ArgumentException>(() => broker.ClaimForApplication(invalidOwner.Id, "../bad", (_, _) => new object()));
            Require(broker.Pending().Length == 1, "invalid destination app must not consume the activation");
            Require(broker.Cancel(invalidOwner.Id), "invalid-owner activation should remain cancellable");

            ExpectFailure<ArgumentException>(() => broker.CaptureCommandLine(new[] { "--open-file" }));
            ExpectFailure<InvalidOperationException>(() => broker.CaptureCommandLine(new[] { "--open-file", textPath, "--open-file", textPath }));
            ExpectFailure<ArgumentException>(() => broker.CaptureCommandLine(new[] { "--open-file", textPath, "unexpected" }));
            ExpectFailure<NotSupportedException>(() => broker.CaptureFile(unsafePath));
            ExpectFailure<FileNotFoundException>(() => broker.CaptureFile(Path.Combine(root, "missing.txt")));

            var cancelled = broker.CaptureFile(textPath);
            Require(broker.Cancel(cancelled.Id), "pending activation should be cancellable");
            Require(!broker.Cancel(cancelled.Id), "cancel must be idempotent after removal");
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { }
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
