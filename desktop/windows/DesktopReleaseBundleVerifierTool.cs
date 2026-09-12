using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopReleaseBundleVerifierTool
{
    public static int Main(string[] args)
    {
        try
        {
            var options = ParseArgs(args);
            var bundleDirectory = Require(options, "bundle-dir");
            var version = Version.Parse(Require(options, "version"));
            var channel = Require(options, "channel");
            var publicKeyPath = Path.GetFullPath(Require(options, "public-key"));
            var packageHost = Require(options, "package-host");

            if (!File.Exists(publicKeyPath))
                throw new UpdateSecurityException("UPDATE_KEY_MISSING", "Release verification public key file does not exist.");

            var result = DesktopReleaseBundleVerifier.Verify(
                bundleDirectory,
                version,
                channel,
                File.ReadAllText(publicKeyPath),
                new[] { packageHost });

            Console.WriteLine(JsonSerializer.Serialize(result));
            return 0;
        }
        catch (Exception ex) when (ex is UpdateSecurityException or ArgumentException or FormatException or IOException or UnauthorizedAccessException)
        {
            var code = ex is UpdateSecurityException security ? security.Code : "UPDATE_RELEASE_BUNDLE_VERIFY_TOOL_ERROR";
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
            if (!values.TryAdd(arg[2..], args[++i]))
                throw new ArgumentException($"Duplicate argument: {arg}");
        }
        return values;
    }

    private static string Require(IReadOnlyDictionary<string, string> options, string name)
        => options.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new ArgumentException($"Missing required argument: --{name}");
}
