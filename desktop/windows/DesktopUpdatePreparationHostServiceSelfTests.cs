using System.Security.Cryptography;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopUpdatePreparationHostServiceSelfTests
{
    public static int Main()
    {
        var failures = new List<string>();
        Run("missing policy stays fail-closed", MissingPolicyStaysFailClosed, failures);
        Run("packaged canonical environment becomes configured", CanonicalPackagedEnvironmentBecomesConfigured, failures);
        Run("non-canonical Current slot is rejected", NonCanonicalCurrentSlotRejected, failures);
        Run("untrusted shell cannot queue preparation", UntrustedShellCannotQueue, failures);
        Run("response failure cancels queued preparation before effects", ResponseFailureCancelsQueue, failures);

        if (failures.Count == 0)
        {
            Console.WriteLine("Desktop update preparation host service self-tests passed.");
            return 0;
        }

        Console.Error.WriteLine(string.Join(Environment.NewLine, failures));
        return 1;
    }

    private static void MissingPolicyStaysFailClosed()
    {
        using var f = new Fixture(writePolicy: false);
        var json = Json(f.Service.Describe());
        Expect(json.GetProperty("configured").GetBoolean() == false, "missing policy must disable preparation");
        Expect(json.GetProperty("failClosed").GetBoolean(), "host service must advertise fail-closed behavior");
    }

    private static void CanonicalPackagedEnvironmentBecomesConfigured()
    {
        using var f = new Fixture(writePolicy: true);
        var json = Json(f.Service.Describe());
        Expect(json.GetProperty("configured").GetBoolean(), "valid policy + Current slot + worker should configure preparation");
        var env = json.GetProperty("environment");
        Expect(env.GetProperty("currentInstallPresent").GetBoolean(), "Current slot should be detected");
        Expect(env.GetProperty("updaterWorkerPresent").GetBoolean(), "Updater Worker should be detected");
        Expect(env.GetProperty("canonicalCurrentSlot").GetBoolean(), "Current slot should be canonical");
    }

    private static void NonCanonicalCurrentSlotRejected()
    {
        using var f = new Fixture(writePolicy: true, nonCanonicalCurrent: true);
        var json = Json(f.Service.Describe());
        Expect(json.GetProperty("configured").GetBoolean() == false, "non-canonical install root must disable preparation");
        Expect(json.GetProperty("environment").GetProperty("canonicalCurrentSlot").GetBoolean() == false, "environment should expose canonical slot failure");
    }

    private static void UntrustedShellCannotQueue()
    {
        using var f = new Fixture(writePolicy: true);
        ExpectThrows("UPDATE_BRIDGE_TRUST_REQUIRED", () => f.Service.QueuePrepare(false));
    }

    private static void ResponseFailureCancelsQueue()
    {
        using var f = new Fixture(writePolicy: true);
        _ = f.Service.QueuePrepare(true);
        var queued = Json(f.Service.Describe()).GetProperty("preparation");
        Expect(queued.GetProperty("state").GetString() == "queued", "trusted request should queue preparation");
        f.Service.CancelQueuedAfterResponseFailure();
        var idle = Json(f.Service.Describe()).GetProperty("preparation");
        Expect(idle.GetProperty("state").GetString() == "idle", "failed bridge acknowledgement must cancel queued preparation");
    }

    private static JsonElement Json(object value)
        => JsonSerializer.SerializeToElement(value);

    private static void ExpectThrows(string code, Action action)
    {
        try { action(); }
        catch (DesktopUpdateBridgeCommandException ex) when (ex.Code == code) { return; }
        throw new InvalidOperationException($"Expected {code}.");
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void Run(string name, Action action, List<string> failures)
    {
        try { action(); Console.WriteLine($"PASS {name}"); }
        catch (Exception ex) { failures.Add($"FAIL {name}: {ex.Message}"); }
    }

    private sealed class Fixture : IDisposable
    {
        private readonly RSA _rsa = RSA.Create(3072);
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "swir-update-host", Guid.NewGuid().ToString("N"));
        public string DeploymentRoot => Path.Combine(Root, "deployment");
        public string TransactionsRoot => Path.Combine(Root, "transactions");
        public string CurrentRoot => Path.Combine(DeploymentRoot, "Current");
        public string PolicyPath => Path.Combine(Root, "desktop-update-policy.json");
        public string WorkerPath => Path.Combine(Root, "SWIR.Desktop.UpdaterWorker.exe");
        public DesktopUpdatePreparationHostService Service { get; }

        public Fixture(bool writePolicy, bool nonCanonicalCurrent = false)
        {
            Directory.CreateDirectory(Root);
            Directory.CreateDirectory(CurrentRoot);
            File.WriteAllText(WorkerPath, "test-worker-placeholder");
            if (writePolicy) WritePolicy();
            var current = nonCanonicalCurrent ? Path.Combine(Root, "unexpected-current") : CurrentRoot;
            if (nonCanonicalCurrent) Directory.CreateDirectory(current);
            Service = new DesktopUpdatePreparationHostService(
                PolicyPath,
                current,
                WorkerPath,
                DeploymentRoot,
                TransactionsRoot);
        }

        private void WritePolicy()
        {
            var policy = new
            {
                Schema = DesktopUpdateReleasePolicy.PolicySchema,
                Enabled = true,
                Channel = "stable",
                ManifestUrl = "https://updates.swir.example/stable.json",
                ManifestHosts = new[] { "updates.swir.example" },
                PackageHosts = new[] { "downloads.swir.example" },
                PublicKeyPem = _rsa.ExportSubjectPublicKeyInfoPem()
            };
            File.WriteAllText(PolicyPath, JsonSerializer.Serialize(policy));
        }

        public void Dispose()
        {
            _rsa.Dispose();
            try { Directory.Delete(Root, true); } catch { }
        }
    }
}