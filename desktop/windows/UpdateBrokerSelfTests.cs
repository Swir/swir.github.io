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
        ExpectCode("UPDATE_PACKAGE_HASH_MISMATCH", () => UpdateBroker.VerifyPackage(Encoding.UTF8.GetBytes("tampered-package-content-xxxxx"), verified), "tampered package rejected");
        ExpectCode("UPDATE_PACKAGE_SIZE_MISMATCH", () => UpdateBroker.VerifyPackage(package[..^1], verified), "wrong package size rejected");

        Console.WriteLine($"SWIR Desktop Update Broker self-tests passed: {_passed}");
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
