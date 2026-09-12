using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Swir.Desktop.Host;

internal static class DesktopUpdatePreparationSelfTests
{
    private static int _passed;

    private static async Task Main()
    {
        await HappyPath();
        await RecoveryGate();
        await RedirectBlocked();
        await TamperedPackageBlocked();
        Console.WriteLine($"Desktop update preparation self-tests passed: {_passed}");
    }

    private static async Task HappyPath()
    {
        using var f = new Fixture();
        var result = await f.Coordinator().PrepareAsync(new Version(0, 5, 1), "stable", f.InstallRoot);
        Expect(result.Ready && result.TargetVersion == new Version(0, 5, 2), "signed update reaches ready state");
        Expect(File.Exists(result.WorkerPlanPath) && File.Exists(result.CandidateStatePath), "worker plan and Candidate state persisted");
        Expect(f.Journal.Read(result.JournalPath).State == "prepared", "preparation does not mutate deployment slots");
        Expect(f.Http.Requests == 2, "manifest and package fetched once");
    }

    private static async Task RecoveryGate()
    {
        using var f = new Fixture();
        var staged = f.StageDirectly();
        f.Journal.Begin(f.Handoff.Prepare(staged, new Version(0, 5, 1), f.InstallRoot));
        await ExpectCode("UPDATE_PREPARATION_RECOVERY_REQUIRED", () => f.Coordinator().PrepareAsync(new Version(0, 5, 1), "stable", f.InstallRoot), "incomplete transaction blocks a second preparation");
        Expect(f.Http.Requests == 0, "recovery gate runs before network access");
    }

    private static async Task RedirectBlocked()
    {
        using var f = new Fixture(HttpStatusCode.Redirect);
        await ExpectCode("UPDATE_MANIFEST_REDIRECT_BLOCKED", () => f.Coordinator().PrepareAsync(new Version(0, 5, 1), "stable", f.InstallRoot), "manifest redirect rejected");
        Expect(f.Journal.RecoverIncomplete().Count == 0, "manifest failure creates no transaction");
    }

    private static async Task TamperedPackageBlocked()
    {
        using var f = new Fixture(tamper: true);
        await ExpectCode("UPDATE_PACKAGE_HASH_MISMATCH", () => f.Coordinator().PrepareAsync(new Version(0, 5, 1), "stable", f.InstallRoot), "same-size package tampering rejected by SHA-256");
        Expect(f.Journal.RecoverIncomplete().Count == 0, "tampered package creates no transaction");
    }

    private sealed class Fixture : IDisposable
    {
        public readonly string Root = Path.Combine(Path.GetTempPath(), "swir-prep", Guid.NewGuid().ToString("N"));
        public string InstallRoot => Path.Combine(Root, "install");
        public string DeploymentRoot => Path.Combine(Root, "deployment");
        public string TransactionsRoot => Path.Combine(Root, "transactions");
        public readonly UpdateStagingBroker Staging;
        public readonly UpdateHandoffBroker Handoff;
        public readonly UpdateTransactionJournal Journal;
        public readonly QueueHandler Http;
        private readonly RSA _rsa = RSA.Create(2048);
        private readonly byte[] _package;

        public Fixture(HttpStatusCode manifestStatus = HttpStatusCode.OK, bool tamper = false)
        {
            Directory.CreateDirectory(InstallRoot);
            Directory.CreateDirectory(DeploymentRoot);
            Staging = new UpdateStagingBroker(Path.Combine(Root, "staging"));
            Handoff = new UpdateHandoffBroker(Path.Combine(Root, "pending"));
            Journal = new UpdateTransactionJournal(TransactionsRoot);
            _package = Package();
            var hash = Hex(SHA256.HashData(_package));
            var manifest = Sign("0.5.2", hash, _package.LongLength);
            var download = _package.ToArray();
            if (tamper) download[download.Length / 2] ^= 0x5a;
            Http = new QueueHandler(
                Response(manifestStatus, Encoding.UTF8.GetBytes(manifest), "application/json"),
                Response(HttpStatusCode.OK, download, "application/octet-stream"));
        }

        public DesktopUpdatePreparationCoordinator Coordinator()
        {
            var broker = new UpdateBroker(_rsa.ExportSubjectPublicKeyInfoPem(), new[] { "downloads.swir.example" });
            var http = new HttpClient(Http) { Timeout = Timeout.InfiniteTimeSpan };
            var manifest = new UpdateManifestClient(broker, new Uri("https://updates.swir.example/stable.json"), new[] { "updates.swir.example" }, http, TimeSpan.FromSeconds(5));
            var download = new UpdateDownloadClient(Staging, http, TimeSpan.FromSeconds(5));
            return new DesktopUpdatePreparationCoordinator(manifest, download, Staging, Handoff, Journal, DeploymentRoot, TransactionsRoot, Path.Combine(Root, "unused.exe"),
                (state, _) => { var plan = new UpdaterWorkerProtocol(Journal, DeploymentRoot).Prepare(state); new CandidatePackagePreparer().Prepare(plan); return Task.CompletedTask; });
        }

        public UpdateStagingBroker.StageStatus StageDirectly()
        {
            var verified = new UpdateBroker.VerifiedUpdate(new Version(0, 5, 2), "stable", DateTimeOffset.UtcNow, new Uri("https://downloads.swir.example/a.zip"), Hex(SHA256.HashData(_package)), _package.LongLength, "test-key");
            using var stream = new MemoryStream(_package, false);
            Staging.StageAsync(stream, verified).GetAwaiter().GetResult();
            return Staging.GetStatus(verified.Version)!;
        }

        private byte[] Package()
        {
            var exe = Encoding.UTF8.GetBytes("SWIR candidate fixture");
            var manifest = JsonSerializer.Serialize(new CandidatePackagePreparer.PackageManifest(CandidatePackagePreparer.PackageManifestSchema, "0.5.2", "SWIR.Desktop.Host.exe", new() { new("SWIR.Desktop.Host.exe", Hex(SHA256.HashData(exe)), exe.LongLength) }));
            using var ms = new MemoryStream();
            using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, true)) { Write(zip, CandidatePackagePreparer.ManifestEntryName, Encoding.UTF8.GetBytes(manifest)); Write(zip, "SWIR.Desktop.Host.exe", exe); }
            return ms.ToArray();
        }

        private string Sign(string version, string hash, long size)
        {
            var payload = JsonSerializer.SerializeToUtf8Bytes(new { Schema = UpdateBroker.PayloadSchema, Version = version, Channel = "stable", PublishedAt = DateTimeOffset.UtcNow, Package = new { Url = "https://downloads.swir.example/swir.zip", Sha256 = hash, Size = size } });
            return JsonSerializer.Serialize(new { Schema = UpdateBroker.EnvelopeSchema, Algorithm = UpdateBroker.SignatureAlgorithm, KeyId = "test-key", Payload = Convert.ToBase64String(payload), Signature = Convert.ToBase64String(_rsa.SignData(payload, HashAlgorithmName.SHA256, RSASignaturePadding.Pss)) });
        }

        public void Dispose() { _rsa.Dispose(); try { if (Directory.Exists(Root)) Directory.Delete(Root, true); } catch { } }
    }

    private sealed class QueueHandler : HttpMessageHandler
    {
        private readonly Queue<HttpResponseMessage> _queue;
        public int Requests { get; private set; }
        public QueueHandler(params HttpResponseMessage[] responses) => _queue = new(responses);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) { Requests++; return Task.FromResult(_queue.Dequeue()); }
    }

    private static HttpResponseMessage Response(HttpStatusCode code, byte[] bytes, string type) { var r = new HttpResponseMessage(code) { Content = new ByteArrayContent(bytes) }; r.Content.Headers.ContentType = new(type); return r; }
    private static void Write(ZipArchive zip, string name, byte[] bytes) { var e = zip.CreateEntry(name, CompressionLevel.NoCompression); using var s = e.Open(); s.Write(bytes); }
    private static string Hex(byte[] value) => Convert.ToHexString(value).ToLowerInvariant();
    private static async Task ExpectCode(string code, Func<Task> action, string label) { try { await action(); throw new Exception($"Expected {code}"); } catch (UpdateSecurityException ex) when (ex.Code == code) { Pass(label); } }
    private static void Expect(bool value, string label) { if (!value) throw new Exception($"FAILED: {label}"); Pass(label); }
    private static void Pass(string label) { _passed++; Console.WriteLine($"PASS: {label}"); }
}
