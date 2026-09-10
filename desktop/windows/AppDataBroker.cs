using System.Text.Json;
using System.Text.RegularExpressions;

namespace Swir.Desktop.Host;

internal sealed class AppDataBroker
{
    private static readonly Regex PackageIdPattern = new("^[a-zA-Z0-9._-]{1,128}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex KeyPattern = new("^[a-zA-Z0-9._-]{1,160}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private const int MaxValueBytes = 1024 * 1024;
    private readonly string _root;

    public AppDataBroker()
    {
        _root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SWIR", "Apps");
        Directory.CreateDirectory(_root);
    }

    public object Info(string packageId)
    {
        var dir = PackageDirectory(packageId, create: false);
        var count = Directory.Exists(dir) ? Directory.EnumerateFiles(dir, "*.json", SearchOption.TopDirectoryOnly).Count() : 0;
        return new { schema = "swir.appdata/0.1", packageId, provider = "native", itemCount = count, rootExposed = false, maxValueBytes = MaxValueBytes };
    }

    public object? Get(string packageId, string key, JsonElement fallback)
    {
        var path = DataPath(packageId, key, createDirectory: false);
        if (!File.Exists(path)) return JsonSerializer.Deserialize<object?>(fallback.GetRawText(), JsonOptions);
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        return JsonSerializer.Deserialize<object?>(document.RootElement.GetRawText(), JsonOptions);
    }

    public object Set(string packageId, string key, JsonElement value)
    {
        var json = value.GetRawText();
        if (System.Text.Encoding.UTF8.GetByteCount(json) > MaxValueBytes)
            throw new BridgeException("APP_DATA_TOO_LARGE", "App Data value exceeds the 1 MiB per-item limit.");
        var path = DataPath(packageId, key, createDirectory: true);
        var temp = path + ".tmp-" + Guid.NewGuid().ToString("N");
        File.WriteAllText(temp, json);
        File.Move(temp, path, true);
        return new { ok = true, packageId, key };
    }

    public bool Remove(string packageId, string key)
    {
        var path = DataPath(packageId, key, createDirectory: false);
        if (!File.Exists(path)) return false;
        File.Delete(path);
        return true;
    }

    public string[] List(string packageId)
    {
        var dir = PackageDirectory(packageId, create: false);
        if (!Directory.Exists(dir)) return Array.Empty<string>();
        return Directory.EnumerateFiles(dir, "*.json", SearchOption.TopDirectoryOnly)
            .Select(path => Path.GetFileNameWithoutExtension(path) ?? string.Empty)
            .Where(name => name.Length > 0)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
    }

    private string DataPath(string packageId, string key, bool createDirectory)
    {
        if (string.IsNullOrWhiteSpace(key) || !KeyPattern.IsMatch(key))
            throw new BridgeException("APP_DATA_INVALID_KEY", "App Data keys may contain only letters, numbers, dot, dash and underscore.");
        return Path.Combine(PackageDirectory(packageId, createDirectory), key + ".json");
    }

    private string PackageDirectory(string packageId, bool create)
    {
        if (string.IsNullOrWhiteSpace(packageId) || !PackageIdPattern.IsMatch(packageId))
            throw new BridgeException("INVALID_APP_ID", "Invalid package identity for App Data.");
        var dir = Path.Combine(_root, packageId, "Data");
        if (create) Directory.CreateDirectory(dir);
        return dir;
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
}
