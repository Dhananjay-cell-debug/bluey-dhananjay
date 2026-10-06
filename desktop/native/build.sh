#!/bin/sh
# Builds BlueyNative.exe against .NET Framework 4.8 (ships with Windows) using the Roslyn compiler.
set -e
cd "$(dirname "$0")"
CSC="${CSC:-/f/toolchains/roslyn/tasks/net472/csc.exe}"
FW='C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
WINMD='C:\Windows\System32\WinMetadata'
"$CSC" -nologo -noconfig -nostdlib+ -optimize+ -platform:x64 -target:exe -langversion:latest -out:BlueyNative.exe \
  -r:"$FW\mscorlib.dll" -r:"$FW\System.dll" -r:"$FW\System.Core.dll" -r:"$FW\System.Drawing.dll" \
  -r:"$FW\System.Windows.Forms.dll" -r:"$FW\System.Web.Extensions.dll" -r:"$FW\Microsoft.CSharp.dll" \
  -r:"$FW\System.Runtime.dll" \
  -r:"$FW\System.Threading.Tasks.dll" -r:"$FW\System.Runtime.WindowsRuntime.dll" -r:"$FW\WPF\WindowsBase.dll" \
  -r:"$FW\WPF\UIAutomationClient.dll" -r:"$FW\WPF\UIAutomationTypes.dll" \
  -r:"$WINMD\Windows.Foundation.winmd" -r:"$WINMD\Windows.Media.winmd" -r:"$WINMD\Windows.Graphics.winmd" \
  -r:"$WINMD\Windows.Globalization.winmd" -r:"$WINMD\Windows.Storage.winmd" -r:"$WINMD\Windows.Security.winmd" \
  BlueyNative.cs
echo built BlueyNative.exe
