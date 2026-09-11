namespace Swir.Desktop.Host;

/// <summary>
/// Canonical Desktop Edition update locations shared by the host and updater.
/// Keeping these paths in one contract prevents recovery from trusting deployment
/// roots supplied by mutable transaction metadata.
/// </summary>
internal static class DesktopUpdatePaths
{
    public static string SwirLocalRoot => Path.GetFullPath(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SWIR"));

    public static string TransactionsRoot => Path.Combine(SwirLocalRoot, "Updates", "Transactions");

    public static string DeploymentRoot => Path.Combine(SwirLocalRoot, "Desktop", "Deployment");

    public static string UpdaterWorkerPath => Path.Combine(AppContext.BaseDirectory, "SWIR.Desktop.UpdaterWorker.exe");
}
