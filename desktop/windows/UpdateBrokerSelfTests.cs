using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Swir.Desktop.Host;

internal static class UpdateBrokerSelfTests
{
    private static int _passed;

    private static void Main()
    {
        using var rsa = RSA.Create(3072);
        var publicKey = rsa.ExportSubjectPublicKeyInfoPem();
        var broker = new UpdateBroker(publicKey, new[] { "downloads.swir.example" });
        var current = new Version(0, 5, 1);
        var package = Encoding.UTF8.GetBytes("SWIR-DESKTOP-UPDATE-PACKAGE");
        var hash = Convert.ToHexString(SHA256.HashData(package)).ToLowerInvariant();

        var envelope = Sign(rsa, "0.5.2", "stable", "https://downloads.swir.example/SWIR.Desktop.0.5.2.zip", hash, package.Length);
        var verified = broker.VerifyManifest(envelope, current, "stable");
        Expect(verified.Version == new Version(0, 5, 2), "valid signed manifest accepted");
        Expect(UpdateBroker.VerifyPackage(package, verified).Verified, "matching package accepted");

        ExpectCode("UPDATE_SIGNATURE_INVALID", () => broker.VerifyManifest(TamperPayload(envelope), current, "stable"), "tampered payload rejected");
        ExpectCode("UPDATE_CHANNEL_MISMATCH", () => broker.VerifyManifest(envelope, current, "preview"), "channel mismatch rejected");
        ExpectCode("UPDATE_DOWNGRADE_BLOCKED", () => broker.VerifyManifest(Sign(rsa, "0.5.1", "stable", "https://downloads.swir.example/a.zip", hash, package.Length), current, "stable"), "same version rejected");
        ExpectCode("UPDATE_DOWNGRADE_BLOCKED", () => broker.VerifyManifest(Sign(rsa, "0.4.9", "stable", "https://downloads.swir.example/a.zip", hash, package.Length), current, "stable"), "downgrade rejected");
        ExpectCode("UPDATE_URL_INVALID", () => broker.VerifyManifest(Sign(rsa, "0.5.2", "stable", "http://downloads.swir.example/a.zip", hash, package.Length), current, "stable"), "HTTP package URL rejected");
        ExpectCode("UPDATE_HOST_DENIED", () => broker.VerifyManifest(Sign(rsa, "0.5.2", "stable", "https://evil.example/a.zip", hash, package.Length), current, "stable"), "untrusted package host rejected");
        ExpectCode("UPDATE_HASH_INVALID", () => broker.VerifyManifest(Sign(rsa, "0.5.2", "stable", "https://downloads.swir.example/a.zip", "abcd", package.Length), current, "stable"), "malformed hash rejected");
        ExpectCode("UPDATE_PACKAGE_SIZE_INVALID", () => broker.VerifyManifest(Sign(rsa, "0.5.2", "stable", "https://downloads.swir.example/a.zip", hash, 0), current, "stable"), "zero package size rejected");

        var tamperedPackage = package.ToArray();
        tamperedPackage[^1] ^= 1;
        ExpectCode("UPDATE_PACKAGE_HASH_MISMATCH", () => UpdateBroker.VerifyPackage(tamperedPackage, verified), "same-size tampered package rejected");
        ExpectCode("UPDATE_PACKAGE_SIZE_MISMATCH", () => UpdateBroker.VerifyPackage(package[..^1], verified), "wrong package size rejected");

        RunStagingTests(package, verified);
        RunDownloadTests(package, verified);
        Console.WriteLine($"SWIR Desktop Update Broker self-tests passed: {_passed}");
    }

    private static void RunStagingTests(byte[] package, UpdateBroker.VerifiedUpdate verified)
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-update-selftest-" + Guid.NewGuid().ToString("N"));
        try
        {
            var staging = new UpdateStagingBroker(root);
            using (var stream = new MemoryStream(package, writable: false))
            {
                var staged = staging.StageAsync(stream, verified).GetAwaiter().GetResult();
                Expect(staged.Verified, "verified package staged");
                Expect(File.Exists(staged.PackagePath), "staged package exists");
                Expect(File.Exists(staged.MetadataPath), "staged metadata exists");
                Expect(File.ReadAllBytes(staged.PackagePath).SequenceEqual(package), "staged package content preserved");
            }

            var status = staging.GetStatus(verified.Version);
            Expect(status is not null && status.Verified && status.Size == package.Length, "staged update status readable");

            var badPackage = package.ToArray();
            badPackage[^1] ^= 1;
            ExpectCode("UPDATE_PACKAGE_HASH_MISMATCH", () =>
            {
                using var stream = new MemoryStream(badPackage, writable: false);
                staging.StageAsync(stream, verified).GetAwaiter().GetResult();
            }, "tampered stream rejected during staging");

            ExpectCode("UPDATE_PACKAGE_SIZE_MISMATCH", () =>
            {
                using var stream = new MemoryStream(package[..^1], writable: false);
                staging.StageAsync(stream, verified).GetAwaiter().GetResult();
            }, "truncated stream rejected during staging");

            var tempFiles = Directory.Exists(root)
                ? Directory.EnumerateFiles(root, "*.tmp", SearchOption.AllDirectories).ToArray()
                : Array.Empty<string>();
            Expect(tempFiles.Length == 0, "failed staging leaves no temporary files");
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static void RunDownloadTests(byte[] package, UpdateBroker.VerifiedUpdate verified)
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-download-selftest-" + Guid.NewGuid().ToString("N"));
        try
        {
            var staging = new UpdateStagingBroker(root);

            using (var client = MakeClient(package, HttpStatusCode.OK, package.Length))
            using (var downloader = new UpdateDownloadClient(staging, client))
            {
                var staged = downloader.DownloadAndStageAsync(verified).GetAwaiter().GetResult();
                Expect(staged.Verified && File.ReadAllBytes(staged.PackagePath).SequenceEqual(package), "signed URI downloaded and staged");
            }

            using (var client = MakeClient(package, HttpStatusCode.Redirect, package.Length, "https://downloads.swir.example/other.zip"))
            using (var downloader = new UpdateDownloadClient(staging, client))
                ExpectCode("UPDATE_REDIRECT_BLOCKED", () => downloader.DownloadAndStageAsync(verified).GetAwaiter().GetResult(), "update redirects rejected");

            using (var client = MakeClient(package, HttpStatusCode.OK, package.Length + 1))
            using (var downloader = new UpdateDownloadClient(staging, client))
                ExpectCode("UPDATE_PACKAGE_SIZE_MISMATCH", () => downloader.DownloadAndStageAsync(verified).GetAwaiter().GetResult(), "wrong Content-Length rejected before staging");

            var tampered = package.ToArray();
            tampered[0] ^= 1;
            using (var client = MakeClient(tampered, HttpStatusCode.OK, tampered.Length))
            using (var downloader = new UpdateDownloadClient(staging, client))
                ExpectCode("UPDATE_PACKAGE_HASH_MISMATCH", () => downloader.DownloadAndStageAsync(verified).GetAwaiter().GetResult(), "downloaded tampered package rejected by staging");

            using (var client = MakeClient(Array.Empty<byte>(), HttpStatusCode.ServiceUnavailable, 0))
            using (var downloader = new UpdateDownloadClient(staging, client))
                ExpectCode("UPDATE_DOWNLOAD_HTTP_STATUS", () => downloader.DownloadAndStageAsync(verified).GetAwaiter().GetResult(), "non-200 update response rejected");

            var requestedUri = (Uri?)null;
            var handler = new StaticHandler(request =>
            {
                requestedUri = request.RequestUri;
                return Response(package, HttpStatusCode.OK, package.Length);
            });
            using (var client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan })
            using (var downloader = new UpdateDownloadClient(staging, client))
                downloader.DownloadAndStageAsync(verified).GetAwaiter().GetResult();
            Expect(requestedUri == verified.PackageUri, "downloader requests exact signed package URI");
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static HttpClient MakeClient(byte[] body, HttpStatusCode status, long? contentLength, string? location = null)
    {
        var handler = new StaticHandler(_ => Response(body, status, contentLength, location));
        return new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    private static HttpResponseMessage Response(byte[] body, HttpStatusCode status, long? contentLength, string? location = null)
    {
        var response = new HttpResponseMessage(status) { Content = new ByteArrayContent(body) };
        if (contentLength.HasValue) response.Content.Headers.ContentLength = contentLength.Value;
        if (location is not null) response.Headers.Location = new Uri(location);
        return response;
    }

    private sealed class StaticHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _factory;
        public StaticHandler(Func<HttpRequestMessage, HttpResponseMessage> factory) => _factory = factory;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(_factory(request));
    }

    private static string Sign(RSA rsa, string version, string channel, string url, string sha256, long size)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            Schema = UpdateBroker.PayloadSchema,
            Version = version,
            Channel = channel,
            PublishedAt = DateTimeOffset.UtcNow,
            Package = new { Url = url, Sha256 = sha256, Size = size }
        });
        var signature = rsa.SignData(payload, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
        return JsonSerializer.Serialize(new
        {
            Schema = UpdateBroker.EnvelopeSchema,
            Algorithm = UpdateBroker.SignatureAlgorithm,
            KeyId = "selftest-2026",
            Payload = Convert.ToBase64String(payload),
            Signature = Convert.ToBase64String(signature)
        });
    }

    private static string TamperPayload(string envelopeJson)
    {
        using var doc = JsonDocument.Parse(envelopeJson);
        var root = doc.RootElement;
        var payload = Convert.FromBase64String(root.GetProperty("Payload").GetString()!);
        payload[^2] ^= 1;
        return JsonSerializer.Serialize(new
        {
            Schema = root.GetProperty("Schema").GetString(),
            Algorithm = root.GetProperty("Algorithm").GetString(),
            KeyId = root.GetProperty("KeyId").GetString(),
            Payload = Convert.ToBase64String(payload),
            Signature = root.GetProperty("Signature").GetString()
        });
    }

    private static void Expect(bool condition, string name)
    {
        if (!condition) throw new Exception("FAILED: " + name);
        _passed++;
        Console.WriteLine("PASS: " + name);
    }

    private static void ExpectCode(string code, Action action, string name)
    {
        try { action(); }
        catch (UpdateSecurityException ex) when (ex.Code == code)
        {
            Expect(true, name);
            return;
        }
        throw new Exception($"FAILED: {name}; expected {code}");
    }
}
