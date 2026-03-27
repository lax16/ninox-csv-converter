# Ninox Backup CSV Converter
This tool can convert Ninox backup files (.ninox) to CSVs containing the backup's table data.

## How to use
First, create a venv and activate it:

```bash
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

Then install the requirements:

```bash
pip install -r requirements.txt
```

**The only requirement is alive-progress for the progress bar. If you don't need it, just remove it from the script**


Then run the script with your backup file

```bash
python main.py <PATH_TO_YOUR_NINOX_BACKUP>
```

Alternatively, place the Ninox backup in the same directory as the script and rename it to `backup.ninox`.
Then run:

```bash
python main.py
```


The CSV files will be placed in the `csv` folder.

Notes:
- linebreaks are removed from the record values since they break the CSV
- double quotes are replaced by single quotes
- reference fields are marked with a `-ref` in their column name (e.g. a field in the column "Location" in `History.csv` that refers to `Locations.csv` would have the ID of the corresponding location record as its value and the column would be renamed "Location-ref")

## How this works
The Ninox backup file is basically just a ZIP file. The script extracts the contents and scans the data.db file inside for data records.
The data.db file contains a key value store with JSON data as the values. This JSON data contains metadata about the creation/modification date of the record
as well as the record's column data.

## Limitations
So far nothing is done for attachments, although they should just refer to a path within the .ninox file.