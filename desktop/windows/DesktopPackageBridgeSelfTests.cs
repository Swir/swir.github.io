using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopPackageBridgeSelfTests
{
    private const string Shell = "swir.system.shell";

    public static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-package-bridge-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var data = Path.Combine(root, "data");
            var bundle = Path.Combine(root, "demo.swirapp");
            CreateBundle(bundle, "swir.demo", "1.0.0");
            var hash = Sha256(bundle);

            var capabilities = new CapabilityBroker();
            var installer = new DesktopAppPackageInstaller(data);
            var bridge = new DesktopPackageBridge(capabilities, installer);

            var token = TokenOf(capabilities.RegisterFile(bundle, Shell));
            var installed = JsonSerializer.Serialize(bridge.InstallFromCapability(token, hash, Shell));
            Require(installed.Contains("swir.demo", StringComparison.Ordinal), "install result should identify package");
            Require(installed.Contains("VERIFIED", StringComparison.Ordinal), "install result should expose verified staged health");
            ExpectBridgeCode(() => capabilities.Describe(token, Shell), "CAPABILITY_INVALID");

            var status = JsonSerializer.Serialize(bridge.Status("swir.demo", Shell));
            Require(status.Contains("1.0.0", StringComparison.Ordinal), "status should expose installed version");
            Require(status.Contains("app/index.html", StringComparison.Ordinal), "status should expose verified package entry");

            var blockedBundle = Path.Combine(root, "blocked.swirapp");
            CreateBundle(blockedBundle, "swir.blocked", "1.0.0", "swir.missing-runtime", "2.0.0");
            var blockedToken = TokenOf(capabilities.RegisterFile(blockedBundle, Shell));
            ExpectPackageCode(() => bridge.InstallFromCapability(blockedToken, Sha256(blockedBundle), Shell), "PACKAGE_DEPENDENCY_UNSATISFIED");
            ExpectBridgeCode(() => capabilities.Describe(blockedToken, Shell), "CAPABILITY_INVALID");
            var blockedStatus = JsonSerializer.Serialize(bridge.Status("swir.blocked", Shell));
            Require(blockedStatus.Contains("\"installed\":false", StringComparison.OrdinalIgnoreCase), "unsatisfied dependency must not install payload");

            var runtimeBundle = Path.Combine(root, "runtime.swirapp");
            CreateBundle(runtimeBundle, "swir.runtime", "2.1.0");
            var runtimeToken = TokenOf(capabilities.RegisterFile(runtimeBundle, Shell));
            bridge.InstallFromCapability(runtimeToken, Sha256(runtimeBundle), Shell);

            var consumerBundle = Path.Combine(root, "consumer.swirapp");
            CreateBundle(consumerBundle, "swir.consumer", "1.0.0", "swir.runtime", "2.0.0");
            var consumerToken = TokenOf(capabilities.RegisterFile(consumerBundle, Shell));
            var consumer = JsonSerializer.Serialize(bridge.InstallFromCapability(consumerToken, Sha256(consumerBundle), Shell));
            Require(consumer.Contains("swir.consumer", StringComparison.Ordinal), "satisfied dependency should allow payload install");

            var badToken = TokenOf(capabilities.RegisterFile(bundle, Shell));
            ExpectPackageCode(() => bridge.InstallFromCapability(badToken, new string('0', 64), Shell), "PACKAGE_HASH_MISMATCH");
            ExpectBridgeCode(() => capabilities.Describe(badToken, Shell), "CAPABILITY_INVALID");

            var foreignToken = TokenOf(capabilities.RegisterFile(bundle, "swir.demo"));
            ExpectPackageCode(() => bridge.InstallFromCapability(foreignToken, hash, "swir.demo"), "PACKAGE_BRIDGE_FORBIDDEN");
            Require(JsonSerializer.Serialize(capabilities.Describe(foreignToken, "swir.demo")).Contains("swir.demo", StringComparison.Ordinal), "forbidden caller capability must not be consumed");

            Console.WriteLine("Desktop package bridge self-tests passed.");
            return 0;
        }
        finally
        {
            try { Directory.Delete(root, true); } catch { }
        }
    }

    private static string TokenOf(object descriptor)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(descriptor));
        return doc.RootElement.GetProperty("token").GetString() ?? throw new InvalidOperationException("Capability token missing.");
    }

    private static void CreateBundle(string path, string packageId, string version, string? dependencyId = null, string? minVersion = null)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
        var manifest = archive.CreateEntry("swir-package.json");
        using (var writer = new StreamWriter(manifest.Open(), new UTF8Encoding(false)))
            writer.Write(JsonSerializer.Serialize(new
            {
                schema = "swir.app/1.0",
                id = packageId,
                packageId,
                name = "SWIR demo",
                version,
                author = "SWIR",
                type = "iframe",
                entry = "app/index.html",
                compatibility = new { minOS = "1.7.0", minSDK = "1.3.0", platformApi = 2, editions = new[] { "DESKTOP" } },
                dependencies = dependencyId is null ? Array.Empty<object>() : new object[] { new { packageId = dependencyId, minVersion } },
                optionalDependencies = Array.Empty<object>()
            }));
        var payload = archive.CreateEntry("app/index.html");
        using var payloadWriter = new StreamWriter(payload.Open(), new UTF8Encoding(false));
        payloadWriter.Write("<!doctype html><title>SWIR demo</title>");
    }

    private static string Sha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static void ExpectPackageCode(Action action, string code)
    {
        try { action(); throw new Exception($"Expected {code}."); }
        catch (DesktopPackageException ex) when (ex.Code == code) { }
    }

    private static void ExpectBridgeCode(Action action, string code)
    {
        try { action(); throw new Exception($"Expected {code}."); }
        catch (BridgeException ex) when (ex.Code == code) { }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
}