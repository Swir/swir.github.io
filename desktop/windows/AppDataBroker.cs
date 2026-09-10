using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Swir.Desktop.Host;

internal sealed class AppDataBroker
{
    private static readonly Regex PackageIdPattern = new("^[a-zA-Z0-9._-]{1,128}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex KeyPattern = new("^[a-zA-Z0-9._-]{1,160}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    internal const int MaxValueBytes = 1024 * 1024;
    internal const long MaxPackageBytes = 16L * 1024 * 1024;
    internal const int MaxItems = 512;
    private readonly string _root;

    public AppDataBroker()
        : this(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SWIR", "Apps"))
    {
    }

    internal AppDataBroker(string root)
    {
        if (string.IsNullOrWhiteSpace(root)) throw new ArgumentException("App Data root is required.", nameof(root));
        _root = Path.GetFullPath(root);
        Directory.CreateDirectory(_root);
    }

    public object Info(string packageId)
    {
        var usage = Usage(packageId);
        return new
        {
            schema = "swir.appdata/0.2",
            packageId,
            provider = "native",
            itemCount = usage.ItemCount,
            usedBytes = usage.UsedBytes,
            quotaBytes = MaxPackageBytes,
            itemLimit = MaxItems,
            maxValueBytes = MaxValueBytes,
            rootExposed = false
        };
    }

    public object? Get(string packageId, string key, JsonElement fallback)
    {
        var path = DataPath(packageId, key, createDirectory: false);
        if (!File.Exists(path)) return JsonSerializer.Deserialize<object?>(fallback.GetRawText(), JsonOptions);

        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.SequentialScan);
            using var document = JsonDocument.Parse(stream);
            return JsonSerializer.Deserialize<object?>(document.RootElement.GetRawText(), JsonOptions);
        }
        catch (JsonException)
        {
            throw new BridgeException("APP_DATA_CORRUPT", "Stored App Data is not valid JSON.");
        }
        catch (IOException ex)
        {
            throw new BridgeException("APP_DATA_IO_ERROR", $"Could not read App Data: {ex.Message}");
        }
    }

    public object Set(string packageId, string key, JsonElement value)
    {
        var json = value.GetRawText();
        var valueBytes = Encoding.UTF8.GetByteCount(json);
        if (valueBytes > MaxValueBytes)
            throw new BridgeException("APP_DATA_TOO_LARGE", "App Data value exceeds the 1 MiB per-item limit.");

        var path = DataPath(packageId, key, createDirectory: true);
        var usage = Usage(packageId);
        var previousBytes = File.Exists(path) ? new FileInfo(path).Length : 0L;
        var nextCount = usage.ItemCount + (File.Exists(path) ? 0 : 1);
        var nextBytes = usage.UsedBytes - previousBytes + valueBytes;

        if (nextCount > MaxItems)
            throw new BridgeException("APP_DATA_ITEM_LIMIT", $"App Data item limit of {MaxItems} entries was reached.");
        if (nextBytes > MaxPackageBytes)
            throw new BridgeException("APP_DATA_QUOTA_EXCEEDED", "App Data package quota of 16 MiB would be exceeded.");

        var temp = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(temp, json, new UTF8Encoding(false));
            File.Move(temp, path, true);
        }
        catch (IOException ex)
        {
            throw new BridgeException("APP_DATA_IO_ERROR", $"Could not persist App Data: {ex.Message}");
        }
        finally
        {
            try { if (File.Exists(temp)) File.Delete(temp); } catch { }
        }

        return new { ok = true, packageId, key, bytes = valueBytes, usedBytes = nextBytes, quotaBytes = MaxPackageBytes };
    }

    public bool Remove(string packageId, string key)
    {
        var path = DataPath(packageId, key, createDirectory: false);
        if (!File.Exists(path)) return false;
        try
        {
            File.Delete(path);
            return true;
        }
        catch (IOException ex)
        {
            throw new BridgeException("APP_DATA_IO_ERROR", $"Could not remove App Data: {ex.Message}");
        }
    }

    public string[] List(string packageId)
    {
        var dir = PackageDirectory(packageId, create: false);
        if (!Directory.Exists(dir)) return Array.Empty<string>();
        return Directory.EnumerateFiles(dir, "*.json", SearchOption.TopDirectoryOnly)
            .Select(path => Path.GetFileNameWithoutExtension(path) ?? string.Empty)
            .Where(name => name.Length > 0 && KeyPattern.IsMatch(name))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
    }

    private UsageSnapshot Usage(string packageId)
    {
        var dir = PackageDirectory(packageId, create: false);
        if (!Directory.Exists(dir)) return new UsageSnapshot(0, 0);

        var files = Directory.EnumerateFiles(dir, "*.json", SearchOption.TopDirectoryOnly)
            .Select(path => new FileInfo(path))
            .Where(info => KeyPattern.IsMatch(Path.GetFileNameWithoutExtension(info.Name)))
            .ToArray();
        return new UsageSnapshot(files.Length, files.Sum(info => info.Length));
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

    private sealed record UsageSnapshot(int ItemCount, long UsedBytes);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
}
