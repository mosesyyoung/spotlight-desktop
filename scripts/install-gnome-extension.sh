#!/bin/sh

set -eu

extension_uuid="spotlight-desktop@mosesyyoung"
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_directory=$(dirname -- "$script_directory")
source_directory="$project_directory/gnome-extension/$extension_uuid"
schema_name="org.gnome.shell.extensions.spotlight-desktop.gschema.xml"
schema_source="$source_directory/schemas/$schema_name"
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
destination_directory="$data_home/gnome-shell/extensions/$extension_uuid"

if [ ! -f "$source_directory/metadata.json" ] || \
   [ ! -f "$source_directory/extension.js" ] || \
   [ ! -f "$source_directory/spotlight.js" ] || \
   [ ! -f "$source_directory/prefs.js" ] || \
   [ ! -f "$schema_source" ]; then
    echo "Error: GNOME extension sources were not found in $source_directory" >&2
    exit 1
fi

install -d "$destination_directory"
install -m 0644 "$source_directory/metadata.json" "$destination_directory/"
install -m 0644 "$source_directory/extension.js" "$destination_directory/"
install -m 0644 "$source_directory/spotlight.js" "$destination_directory/"
install -m 0644 "$source_directory/prefs.js" "$destination_directory/"
install -m 0644 "$source_directory/stylesheet.css" "$destination_directory/"
install -d "$destination_directory/schemas"
install -m 0644 "$schema_source" "$destination_directory/schemas/"
glib-compile-schemas "$destination_directory/schemas"

echo "Installed $extension_uuid to:"
echo "  $destination_directory"
echo
echo "Enable it with:"
echo "  gnome-extensions enable $extension_uuid"
echo
echo "Configure it with:"
echo "  gnome-extensions prefs $extension_uuid"
echo
echo "If GNOME Shell does not recognize a newly installed extension, log out"
echo "and log back in, then run the enable command again."
