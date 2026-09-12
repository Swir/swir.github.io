using System.Security.Cryptography;

namespace Swir.Desktop.Host;

internal static class DesktopReleaseBundleTool
{
    public static int Main(string[] args)
    {
        try
        {
            var options = ParseArgs(args);
            var source = Require(options, "source");
            var output = Require(options, "output-dir");
            var version = Version.Parse(Require(options, "version"));
            var entryPoint = Require(options, "entry-point");
            var packageUrl = new Uri(Require(options, "package-url"), UriKind.Absolute);
            var channel = Require(options, "channel");
            var keyId = Require(options, "key-id");
            var privateKeyPath = Path.GetFullPath(Require(options, "private-key"));
            var publishedAt = options.TryGetValue("published-at", out var publishedValue)
                ? DateTimeOffset.Parse(
                    publishedValue,
                    System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal)
                : DateTimeOffset.UtcNow;

            if (!File.Exists(privateKeyPath))
                throw new UpdateSecurityException("UPDATE_RELEASE_PRIVATE_KEY_MISSING", "Release signing private key file does not exist.");

            var privateKeyPem = File.ReadAllText(privateKeyPath);
            var result = DesktopReleaseBundleBuilder.Build(
                source,
                output,
                version,
                entryPoint,
                packageUrl,
                channel,
                keyId,
                privateKeyPem,
                publishedAt);

            Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(result));
            return 0;
        }
        catch (Exception ex) when (ex is UpdateSecurityException or ArgumentException or FormatException or UriFormatException or IOException or UnauthorizedAccessException or CryptographicException)
        {
            var code = ex is UpdateSecurityException security ? security.Code : "UPDATE_RELEASE_BUNDLE_TOOL_ERROR";
            Console.Error.WriteLine($"{code}: {ex.Message}");
            return 2;
        }
    }

    private static Dictionary<string, string> ParseArgs(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (!arg.StartsWith("--", StringComparison.Ordinal) || arg.Length <= 2)
                throw new ArgumentException($"Unexpected argument: {arg}");
            if (i + 1 >= args.Length || args[i + 1].StartsWith("--", StringComparison.Ordinal))
                throw new ArgumentException($"Missing value for {arg}");
            var name = arg[2..];
            if (!values.TryAdd(name, args[++i]))
                throw new ArgumentException($"Duplicate argument: --{name}");
        }
        return values;
    }

    private static string Require(IReadOnlyDictionary<string, string> options, string name)
        => options.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new ArgumentException($"Missing required argument: --{name}");
}
