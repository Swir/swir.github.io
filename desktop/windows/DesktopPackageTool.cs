using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopPackageTool
{
    private static int Main(string[] args)
    {
        if (args.Length != 4)
        {
            Console.Error.WriteLine("Usage: SWIR.Desktop.PackageTool <source-dir> <output.zip> <version> <entry-point>");
            return 2;
        }

        try
        {
            if (!Version.TryParse(args[2], out var version))
                throw new UpdateSecurityException("UPDATE_PACKAGE_VERSION_INVALID", "Desktop package version is invalid.");

            var result = DesktopPackageBuilder.Build(args[0], args[1], version, args[3]);
            Console.WriteLine(JsonSerializer.Serialize(result));
            return 0;
        }
        catch (UpdateSecurityException ex)
        {
            Console.Error.WriteLine($"{ex.Code}: {ex.Message}");
            return 3;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidDataException or OverflowException)
        {
            Console.Error.WriteLine($"UPDATE_PACKAGE_TOOL_FAILED: {ex.Message}");
            return 4;
        }
    }
}
