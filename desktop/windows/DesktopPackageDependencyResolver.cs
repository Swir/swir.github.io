using System.Text.Json;

namespace Swir.Desktop.Host;

internal sealed class DesktopPackageDependencyResolver
{
    public const string Contract = "swir.dependencies/1.0";
    private readonly RuntimeInfo _runtime;

    public DesktopPackageDependencyResolver(RuntimeInfo runtime)
    {
        _runtime = runtime;
    }

    public DependencyResult EvaluateManifest(string manifestPath, IEnumerable<InstalledPackageInfo> installed)
    {
        if (!File.Exists(manifestPath))
            throw new DesktopPackageException("PACKAGE_MANIFEST_MISSING", "Dependency preflight requires swir-package.json.");

        PackageMetadata? package;
        try
        {
            package = JsonSerializer.Deserialize<PackageMetadata>(File.ReadAllText(manifestPath), JsonOptions);
        }
        catch (JsonException ex)
        {
            throw new DesktopPackageException("PACKAGE_MANIFEST_INVALID", ex.Message);
        }

        if (package is null || !string.Equals(package.Schema, "swir.app/1.0", StringComparison.Ordinal))
            throw new DesktopPackageException("PACKAGE_MANIFEST_INVALID", "Package manifest schema must be swir.app/1.0.");

        return Evaluate(package, installed);
    }

    public DependencyResult Evaluate(PackageMetadata package, IEnumerable<InstalledPackageInfo> installed)
    {
        var errors = new List<string>();
        var warnings = new List<string>();
        var compatibility = package.Compatibility ?? new CompatibilityInfo();
        var inventory = installed.Where(x => x.Installed).ToList();

        if (!string.IsNullOrWhiteSpace(compatibility.MinOS) && !Satisfies(_runtime.OS, compatibility.MinOS))
            errors.Add($"Requires SWIR OS {compatibility.MinOS}+ (current {_runtime.OS})");
        if (!string.IsNullOrWhiteSpace(compatibility.MinSDK) && !Satisfies(_runtime.SDK, compatibility.MinSDK))
            errors.Add($"Requires SWIR App SDK {compatibility.MinSDK}+ (current {_runtime.SDK})");
        if (compatibility.PlatformApi is > 0 && _runtime.PlatformApi < compatibility.PlatformApi.Value)
            errors.Add($"Requires Platform API {compatibility.PlatformApi}+ (current {_runtime.PlatformApi})");

        if (compatibility.Editions is { Count: > 0 } &&
            !compatibility.Editions.Any(x => string.Equals(x, _runtime.Edition, StringComparison.OrdinalIgnoreCase)))
            errors.Add($"Edition {_runtime.Edition} is not supported");

        foreach (var dependency in package.Dependencies ?? [])
        {
            var key = DependencyKey(dependency);
            var found = FindInstalled(inventory, key);
            if (found is null)
            {
                errors.Add($"Missing dependency: {key}{(string.IsNullOrWhiteSpace(dependency.MinVersion) ? string.Empty : $" {dependency.MinVersion}+")}");
                continue;
            }
            if (!string.IsNullOrWhiteSpace(dependency.MinVersion) && !Satisfies(found.Version, dependency.MinVersion))
                errors.Add($"Dependency {key} must be {dependency.MinVersion}+ (installed {found.Version})");
        }

        foreach (var dependency in package.OptionalDependencies ?? [])
        {
            var key = DependencyKey(dependency);
            var found = FindInstalled(inventory, key);
            if (found is null)
                warnings.Add($"Optional dependency unavailable: {key}");
            else if (!string.IsNullOrWhiteSpace(dependency.MinVersion) && !Satisfies(found.Version, dependency.MinVersion))
                warnings.Add($"Optional dependency {key} is older than {dependency.MinVersion}");
        }

        return new DependencyResult(Contract, errors.Count == 0, errors, warnings, _runtime, package.PackageId ?? package.Id ?? string.Empty, package.Version ?? "0.0.0");
    }

    public static int CompareVersions(string? a, string? b)
    {
        var aa = VersionParts(a);
        var bb = VersionParts(b);
        var len = Math.Max(Math.Max(aa.Length, bb.Length), 3);
        for (var i = 0; i < len; i++)
        {
            var av = i < aa.Length ? aa[i] : 0;
            var bv = i < bb.Length ? bb[i] : 0;
            if (av > bv) return 1;
            if (av < bv) return -1;
        }
        return 0;
    }

    public static bool Satisfies(string? current, string? minimum) => string.IsNullOrWhiteSpace(minimum) || CompareVersions(current, minimum) >= 0;

    public static InstalledPackageInfo? ReadInstalledManifest(string manifestPath)
    {
        if (!File.Exists(manifestPath)) return null;
        try
        {
            var package = JsonSerializer.Deserialize<PackageMetadata>(File.ReadAllText(manifestPath), JsonOptions);
            if (package is null) return null;
            var id = package.Id ?? package.PackageId;
            var packageId = package.PackageId ?? package.Id;
            if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(packageId) || string.IsNullOrWhiteSpace(package.Version)) return null;
            return new InstalledPackageInfo(id, packageId, package.Version, true);
        }
        catch
        {
            return null;
        }
    }

    private static InstalledPackageInfo? FindInstalled(IEnumerable<InstalledPackageInfo> installed, string key) =>
        installed.FirstOrDefault(x => string.Equals(x.PackageId, key, StringComparison.Ordinal) || string.Equals(x.Id, key, StringComparison.Ordinal));

    private static string DependencyKey(DependencyInfo dependency)
    {
        var key = dependency.PackageId ?? dependency.Id;
        return string.IsNullOrWhiteSpace(key) ? "<invalid>" : key.Trim();
    }

    private static int[] VersionParts(string? value)
    {
        var normalized = (value ?? "0").Trim();
        if (normalized.StartsWith('v') || normalized.StartsWith('V')) normalized = normalized[1..];
        var splitAt = normalized.IndexOfAny(['+', '-']);
        if (splitAt >= 0) normalized = normalized[..splitAt];
        return normalized.Split('.', StringSplitOptions.RemoveEmptyEntries)
            .Select(part => int.TryParse(part, out var parsed) ? parsed : 0)
            .ToArray();
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    internal sealed record RuntimeInfo(string OS, string SDK, int PlatformApi, string Edition);
    internal sealed record InstalledPackageInfo(string Id, string PackageId, string Version, bool Installed = true);
    internal sealed record DependencyResult(string Schema, bool Ok, IReadOnlyList<string> Errors, IReadOnlyList<string> Warnings, RuntimeInfo Runtime, string PackageId, string Version);
    internal sealed record PackageMetadata(
        string? Schema,
        string? Id,
        string? PackageId,
        string? Name,
        string? Version,
        string? Author,
        string? Type,
        string? Entry,
        CompatibilityInfo? Compatibility,
        List<DependencyInfo>? Dependencies,
        List<DependencyInfo>? OptionalDependencies);
    internal sealed record CompatibilityInfo(string? MinOS = null, string? MinSDK = null, int? PlatformApi = null, List<string>? Editions = null);
    internal sealed record DependencyInfo(string? Id = null, string? PackageId = null, string? MinVersion = null);
}
