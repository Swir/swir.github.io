using System.Text.Json;
using Swir.Desktop.Host;

var vectorsPath = Path.GetFullPath(Path.Combine(Environment.CurrentDirectory, "..", "..", "contracts", "swir-dependency-vectors.json"));
if (!File.Exists(vectorsPath)) throw new Exception($"Missing shared vectors: {vectorsPath}");

using var document = JsonDocument.Parse(File.ReadAllText(vectorsPath));
var root = document.RootElement;
var rt = root.GetProperty("runtime");
var resolver = new DesktopPackageDependencyResolver(new DesktopPackageDependencyResolver.RuntimeInfo(
    rt.GetProperty("os").GetString()!,
    rt.GetProperty("sdk").GetString()!,
    rt.GetProperty("platformApi").GetInt32(),
    rt.GetProperty("edition").GetString()!));

foreach (var test in root.GetProperty("cases").EnumerateArray())
{
    var package = JsonSerializer.Deserialize<DesktopPackageDependencyResolver.PackageMetadata>(test.GetProperty("package").GetRawText(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
    var installed = JsonSerializer.Deserialize<List<DesktopPackageDependencyResolver.InstalledPackageInfo>>(test.GetProperty("installed").GetRawText(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? [];
    var result = resolver.Evaluate(package, installed);
    var expectedOk = test.GetProperty("ok").GetBoolean();
    var expectedErrors = test.GetProperty("errorCount").GetInt32();
    var expectedWarnings = test.GetProperty("warningCount").GetInt32();
    if (result.Ok != expectedOk || result.Errors.Count != expectedErrors || result.Warnings.Count != expectedWarnings)
        throw new Exception($"Vector '{test.GetProperty("name").GetString()}' mismatch: ok={result.Ok}, errors={result.Errors.Count}, warnings={result.Warnings.Count}");
}

if (DesktopPackageDependencyResolver.CompareVersions("1.10.0", "1.9.9") <= 0) throw new Exception("Version comparator regression.");
if (DesktopPackageDependencyResolver.CompareVersions("v1.4.0-beta", "1.4.0") != 0) throw new Exception("Version normalization regression.");

Console.WriteLine($"Desktop dependency contract OK: {root.GetProperty("cases").GetArrayLength()} shared vectors.");
