// A console-owning supervisor lets Go receive Ctrl+C on Windows and close TUN
// routes, DNS and WFP sessions. EOF also cleans up if the desktop process dies.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class TunHost {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Startup {
        public int cb; public string reserved, desktop, title;
        public int x, y, width, height, charsX, charsY, fill, flags;
        public short show; public short reservedSize;
        public IntPtr reservedPtr, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup si, out ProcessInfo pi);
    [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint type, uint group);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attr, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint length);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    static int Main(string[] args) {
        if (args.Length != 2 || !System.IO.Path.IsPathRooted(args[0]) || !System.IO.Path.IsPathRooted(args[1])) return 2;
        IntPtr job = IntPtr.Zero;
        IntPtr child = IntPtr.Zero;
        try {
            // JOBOBJECT_EXTENDED_LIMIT_INFORMATION: LimitFlags at offset 16.
            job = CreateJobObject(IntPtr.Zero, null);
            int size = IntPtr.Size == 8 ? 144 : 112;
            IntPtr limits = Marshal.AllocHGlobal(size);
            try {
                for (int i = 0; i < size; i++) Marshal.WriteByte(limits, i, 0);
                Marshal.WriteInt32(limits, 16, 0x2000); // KILL_ON_JOB_CLOSE
                if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, limits, (uint)size)) throw new Exception("Cannot create cleanup job");
            } finally { Marshal.FreeHGlobal(limits); }
            Startup si = new Startup(); si.cb = Marshal.SizeOf(si); si.flags = 1; si.show = 0;
            ProcessInfo pi;
            var cmd = new StringBuilder(Quote(args[0]) + " run -c " + Quote(args[1]));
            if (!CreateProcess(args[0], cmd, IntPtr.Zero, IntPtr.Zero, false, 0x10 | 0x4, IntPtr.Zero, System.IO.Path.GetDirectoryName(args[0]), ref si, out pi))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            try {
                if (!AssignProcessToJobObject(job, pi.process)) { TerminateProcess(pi.process, 1); throw new Exception("Cannot supervise TUN process"); }
                child = pi.process;
                ResumeThread(pi.thread);
            } finally { CloseHandle(pi.thread); if (child == IntPtr.Zero) CloseHandle(pi.process); }
            Console.WriteLine("PID:" + pi.pid); Console.Out.Flush();
            Thread reader = new Thread(() => { try { Console.ReadLine(); } catch {} Stop(child, pi.pid); });
            reader.IsBackground = true; reader.Start();
            WaitForSingleObject(child, 0xFFFFFFFF);
            uint exitCode;
            return GetExitCodeProcess(child, out exitCode) ? (int)exitCode : 1;
        } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
        finally { if (job != IntPtr.Zero) CloseHandle(job); if (child != IntPtr.Zero) CloseHandle(child); }
    }
    static void Stop(IntPtr child, int pid) {
        try {
            if (WaitForSingleObject(child, 0) == 0) return;
            FreeConsole();
            if (!AttachConsole((uint)pid)) throw new Exception("Cannot attach TUN console");
            SetConsoleCtrlHandler(IntPtr.Zero, true);
            GenerateConsoleCtrlEvent(0, 0); // CTRL_C_EVENT -> os.Interrupt
            Thread.Sleep(100);
            FreeConsole();
            if (WaitForSingleObject(child, 15000) != 0) TerminateProcess(child, 1);
        } catch { TerminateProcess(child, 1); }
    }
}
