using Swir.Desktop.Host;

internal static class UpdaterActivationCrashHarness
{
    private const int InjectedCrashExitCode = 93;

    private static int Main(string[] args)
    {
        if (args.Length != 4)
        {
            Console.Error.WriteLine("Usage: SWIR.Desktop.Updater.ActivationCrashHarness <journal> <transactions-root> <deployment-root> <failure-point>");
            return 2;
        }

        var journalPath = Path.GetFullPath(args[0]);
        var transactionsRoot = Path.GetFullPath(args[1]);
        var deploymentRoot = Path.GetFullPath(args[2]);
        var failurePoint = args[3];
        if (failurePoint is not ("after-journal-applying" or "after-current-backup" or "after-candidate-promote"))
        {
            Console.Error.WriteLine("Unsupported failure point.");
            return 2;
        }

        try
        {
            var journal = new UpdateTransactionJournal(transactionsRoot);
            var state = journal.Read(journalPath);
            var planPath = Path.Combine(Path.GetDirectoryName(journalPath)!, "worker-plan.json");
            var protocol = new UpdaterWorkerProtocol(journal, deploymentRoot);
            var plan = protocol.Read(planPath, state);
            var candidateStatePath = Path.Combine(plan.CandidateRoot, "candidate-state.json");
            var preparer = new CandidatePackagePreparer();
            var candidate = preparer.ReadAndVerify(plan, candidateStatePath);
            var activator = new DeploymentSlotActivator(journal, preparer, point =>
            {
                if (string.Equals(point, failurePoint, StringComparison.Ordinal))
                    Environment.Exit(InjectedCrashExitCode);
            });

            activator.Activate(plan, candidate);
            Console.Error.WriteLine("Failure injection point was not reached.");
            return 94;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
    }
}
