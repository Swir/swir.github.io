using System.Text.Json;
using System.Text.RegularExpressions;

namespace Swir.Desktop.Host;

internal sealed class ExecutionPolicyCatalog
{
    private static readonly Regex PackageIdPattern = new("^[a-zA-Z0-9._-]{1,128}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private readonly Dictionary<string, PackagePolicy> _packages;

    public ExecutionPolicyCatalog(string policyPath)
    {
        if (!File.Exists(policyPath))
            throw new FileNotFoundException("Desktop package policy registry was not found.", policyPath);

        var file = JsonSerializer.Deserialize<PolicyFile>(File.ReadAllText(policyPath), JsonOptions)
            ?? throw new InvalidDataException("Desktop package policy registry is empty or invalid.");
        if (!string.Equals(file.Schema, "swir.desktop-policy/0.1", StringComparison.Ordinal))
            throw new InvalidDataException($"Unsupported desktop package policy schema: {file.Schema}");

        _packages = new Dictionary<string, PackagePolicy>(StringComparer.Ordinal);
        foreach (var policy in file.Packages ?? Array.Empty<PackagePolicy>())
        {
            Validate(policy);
            if (!_packages.TryAdd(policy.PackageId, policy with { Permissions = policy.Permissions.Distinct(StringComparer.Ordinal).OrderBy(x => x, StringComparer.Ordinal).ToArray() }))
                throw new InvalidDataException($"Duplicate desktop package policy: {policy.PackageId}");
        }
    }

    public PackagePolicy Require(string packageId)
    {
        if (!_packages.TryGetValue(packageId, out var policy))
            throw new BridgeException("PACKAGE_POLICY_MISSING", $"No trusted Desktop execution policy exists for {packageId}.");
        return policy;
    }

    public IReadOnlyList<PackagePolicy> All() => _packages.Values.OrderBy(policy => policy.PackageId, StringComparer.Ordinal).ToArray();

    public string[] ResolveNativePermissions(string packageId, IEnumerable<string> grantedPackagePermissions)
    {
        var policy = Require(packageId);
        var declared = policy.Permissions.ToHashSet(StringComparer.Ordinal);
        var granted = grantedPackagePermissions.Distinct(StringComparer.Ordinal).ToArray();
        var undeclared = granted.Where(permission => !declared.Contains(permission)).ToArray();
        if (undeclared.Length > 0)
            throw new BridgeException("PACKAGE_PERMISSION_ESCALATION", $"Package {packageId} requested undeclared Desktop grants: {string.Join(", ", undeclared)}");

        var native = new HashSet<string>(StringComparer.Ordinal) { "runtime.inspect" };
        foreach (var permission in granted)
        {
            switch (permission)
            {
                case "storage":
                    native.Add("filesystem.sandbox.read");
                    native.Add("filesystem.sandbox.write");
                    break;
                case "files.read":
                    native.Add("filesystem.picker");
                    native.Add("filesystem.capability.read");
                    break;
                case "files.write":
                    native.Add("filesystem.sandbox.read");
                    native.Add("filesystem.sandbox.write");
                    break;
                case "clipboard":
                    native.Add("clipboard.read");
                    native.Add("clipboard.write");
                    break;
            }
        }
        return native.OrderBy(x => x, StringComparer.Ordinal).ToArray();
    }

    public object Describe() => new
    {
        schema = "swir.desktop-policy/0.1",
        packageCount = _packages.Count,
        packages = All().Select(policy => new { packageId = policy.PackageId, entry = policy.Entry, permissions = policy.Permissions }).ToArray()
    };

    private static void Validate(PackagePolicy policy)
    {
        if (string.IsNullOrWhiteSpace(policy.PackageId) || !PackageIdPattern.IsMatch(policy.PackageId))
            throw new InvalidDataException("Desktop package policy contains an invalid packageId.");
        if (string.IsNullOrWhiteSpace(policy.Entry) || !policy.Entry.StartsWith("./", StringComparison.Ordinal) || policy.Entry.Contains("..", StringComparison.Ordinal) || Uri.TryCreate(policy.Entry, UriKind.Absolute, out _))
            throw new InvalidDataException($"Desktop package policy {policy.PackageId} contains an unsafe entry path.");
        if (policy.Permissions is null || policy.Permissions.Any(string.IsNullOrWhiteSpace))
            throw new InvalidDataException($"Desktop package policy {policy.PackageId} contains invalid permissions.");
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = true };
    private sealed record PolicyFile(string Schema, PackagePolicy[]? Packages);
    internal sealed record PackagePolicy(string PackageId, string Entry, string[] Permissions);
}
