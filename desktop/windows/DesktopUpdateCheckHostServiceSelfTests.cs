using System.Net;
using System.Security.Cryptography;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopUpdateCheckHostServiceSelfTests
{
    public static int Main()
    {
        var failures = new List<string>();
        Run("signed newer manifest is discovered without packaged Current slot", SignedNewerManifestDiscovered, failures);
        Run("same signed version reports system current", SameVersionReportsCurrent, failures);
        Run("signed downgrade remains blocked", SignedDowngradeBlocked, failures);
        Run("untrusted caller cannot check feed", UntrustedCallerRejected, failures);
        if (failures.Count == 0) { Console.WriteLine("Desktop update check host self-tests passed."); return 0; }
        Console.Error.WriteLine(string.Join(Environment.NewLine, failures)); return 1;
    }

    private static void SignedNewerManifestDiscovered()
    {
        using var f = new Fixture("0.5.2");
        var result = Json(f.Service.CheckAsync(true).GetAwaiter().GetResult());
        Expect(result.GetProperty("updateAvailable").GetBoolean(), "newer signed release must be available");
        Expect(result.GetProperty("targetVersion").GetString() == "0.5.2", "target version must come from signed payload");
        Expect(result.GetProperty("verified").GetBoolean(), "check result must be signature verified");
        var describe = Json(f.Service.Describe());
        Expect(describe.GetProperty("feedConfigured").GetBoolean(), "release feed can be configured independently of packaged activation environment");
        Expect(!describe.GetProperty("configured").GetBoolean(), "preparation must remain disabled without packaged Current/worker");
    }

    private static void SameVersionReportsCurrent()
    {
        using var f = new Fixture("0.5.1");
        var result = Json(f.Service.CheckAsync(true).GetAwaiter().GetResult());
        Expect(!result.GetProperty("updateAvailable").GetBoolean(), "same signed version should report current");
        Expect(result.GetProperty("status").GetString() == "current", "same version should have current status");
    }

    private static void SignedDowngradeBlocked()
    {
        using var f = new Fixture("0.4.9");
        try { _ = f.Service.CheckAsync(true).GetAwaiter().GetResult(); }
        catch (UpdateSecurityException ex) when (ex.Code == "UPDATE_DOWNGRADE_BLOCKED") { return; }
        throw new InvalidOperationException("Expected UPDATE_DOWNGRADE_BLOCKED.");
    }

    private static void UntrustedCallerRejected()
    {
        using var f = new Fixture("0.5.2");
        try { _ = f.Service.CheckAsync(false).GetAwaiter().GetResult(); }
        catch (DesktopUpdateBridgeCommandException ex) when (ex.Code == "UPDATE_BRIDGE_TRUST_REQUIRED") { return; }
        throw new InvalidOperationException("Expected UPDATE_BRIDGE_TRUST_REQUIRED.");
    }

    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);
    private static void Expect(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private static void Run(string name, Action test, List<string> failures)
    {
        try { test(); Console.WriteLine($"PASS {name}"); }
        catch (Exception ex) { failures.Add($"FAIL {name}: {ex.Message}"); }
    }

    private sealed class Fixture : IDisposable
    {
        private readonly RSA _rsa = RSA.Create(3072);
        private readonly string _root = Path.Combine(Path.GetTempPath(), "swir-update-check", Guid.NewGuid().ToString("N"));
        public DesktopUpdatePreparationHostService Service { get; }

        public Fixture(string manifestVersion)
        {
            Directory.CreateDirectory(_root);
            var policyPath = Path.Combine(_root, "desktop-update-policy.json");
            File.WriteAllText(policyPath, JsonSerializer.Serialize(new
            {
                Schema = DesktopUpdateReleasePolicy.PolicySchema,
                Enabled = true,
                Channel = "stable",
                ManifestUrl = "https://updates.swir.example/stable.json",
                ManifestHosts = new[] { "updates.swir.example" },
                PackageHosts = new[] { "downloads.swir.example" },
                PublicKeyPem = _rsa.ExportSubjectPublicKeyInfoPem()
            }));
            var envelope = Sign(manifestVersion);
            Service = new DesktopUpdatePreparationHostService(
                policyPath,
                Path.Combine(_root, "deployment", "Current"),
                Path.Combine(_root, "missing-worker.exe"),
                Path.Combine(_root, "deployment"),
                Path.Combine(_root, "transactions"),
                (broker, uri, hosts) => new UpdateManifestClient(
                    broker,
                    uri,
                    hosts,
                    new HttpClient(new StaticHandler(envelope)) { Timeout = Timeout.InfiniteTimeSpan }));
        }

        private string Sign(string version)
        {
            var payload = JsonSerializer.SerializeToUtf8Bytes(new
            {
                Schema = UpdateBroker.PayloadSchema,
                Version = version,
                Channel = "stable",
                PublishedAt = DateTimeOffset.UtcNow,
                Package = new { Url = "https://downloads.swir.example/SWIR.Desktop.zip", Sha256 = new string('a', 64), Size = 1234L }
            });
            var signature = _rsa.SignData(payload, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
            return JsonSerializer.Serialize(new
            {
                Schema = UpdateBroker.EnvelopeSchema,
                Algorithm = UpdateBroker.SignatureAlgorithm,
                KeyId = "selftest-check-2026",
                Payload = Convert.ToBase64String(payload),
                Signature = Convert.ToBase64String(signature)
            });
        }

        public void Dispose()
        {
            _rsa.Dispose();
            try { Directory.Delete(_root, true); } catch { }
        }
    }

    private sealed class StaticHandler : HttpMessageHandler
    {
        private readonly string _body;
        public StaticHandler(string body) => _body = body;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(_body) });
    }
}
