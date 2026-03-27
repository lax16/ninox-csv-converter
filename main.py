import zipfile
import sys
import json
import re

from alive_progress import alive_bar

def main():
    archive_path = sys.argv[1] if len(sys.argv) > 1 else 'backup.ninox'

    tables = {}
    records = []
    csv_data = {}

    print(f"Extracting data from {archive_path}...")
    with zipfile.ZipFile(archive_path, 'r') as zip_ref:
        zip_ref.extractall('extracted')

    print("Processing extracted data...")
    with open('extracted/data.db', 'r', encoding="utf-8") as f:
        data = f.readlines()

        json_data = re.search(r'^([a-zA-Z1-9]+):(\{.*\})$', data[0])
        tables = json.loads(json_data.group(2))['types']

        for line in data:
            # the data is in the format "U{table_id}{index}:{json_data}" for records and "{table_id}:{json_data}" for tables,
            json_data = re.search(r'^([a-zA-Z1-9]+):(\{.*\})$', line)
            if json_data:
                # escape double quotes in the json data to avoid issues with the json parser
                # we replace them with single quotes because the json data in the backup file uses double quotes for the keys and values,
                data = json.loads(json_data.group(2).replace('\\"', "'"))

                # if the data contains "_cu" it means it's a record, we store it in a list and later 
                # we will search for the table it belongs to using the "table_id" field we create here
                if "_cu" in data:
                    record_data = data
                    # here we extract the table_id from the record's key, it's in the format "U{table_id}{index}", we only need the table_id part
                    table_name = re.search(r'U([A-Z]+)[0-9]*', json_data.group(1))
                    record_data['table_id'] = table_name.group(1)
                    records.append(record_data)

    # here we scan all the records and search for the table they belong to
    # the table_id we stored previously corresponds to the tables "type" field
    with alive_bar(len(records), title="Generating CSV files...") as bar:
        for record in records:
            # this means the record belongs to a table we haven't found, we skip it
            if record['table_id'] not in tables:
                # update progress bar and continue to the next record
                bar()
                continue

            # grab the caption of the table to use it as the csv file name
            table_name = tables[record['table_id']]['caption']
            
            # this contains the mapping between the column ids and their captions, 
            # we will use it to create the header of the csv file and to get the captions for choice fields
            columns = tables[record['table_id']]['fields']

            # create header if this is the first record of the table we encounter, 
            # we use the "fields" field of the table to get the column names
            if table_name not in csv_data:
                header_line = "Erstellungsdatum;Änderungsdatum;"
                for column_id, column in columns.items():
                    # add the column caption to the header line, 
                    # if the column is a reference field we add "-ref" to the caption to indicate that it's a reference,
                    if column["base"] == "ref":
                        header_line += f"{column['caption']}-ref;"
                    else:
                        header_line += f"{column['caption']};"

                header_line = header_line.rstrip(";")  # remove the last ";" from the line
                csv_data[table_name] = header_line
                csv_data[table_name] += "\n"

            if "_cd" in record:
                csv_data[table_name] += f"{record['_cd']};"  # add creation date to the csv data
            else:                
                csv_data[table_name] += ";"  # if there is no creation date, we add an empty value to keep the columns aligned

            if "_md" in record:
                csv_data[table_name] += f"{record['_md']};"  # add modification date to the csv data
            else:                
                csv_data[table_name] += ";"  # if there is no modification date, we add an empty value to keep the columns aligned

            # go though all of the columns of the record and add them to the csv data, 
            # we separate the values with a ";" to avoid issues with commas in the data
            for column_id, column in columns.items():
                record_value = record[column_id] if column_id in record else ""

                # if the column is a choice field, we want to replace the value with the corresponding caption,
                if column["base"] == "choice":
                    # if the column has predefined values, we want to replace the value with the corresponding caption, 
                    # this is because the value is usually an id that doesn't make sense to the user, while the caption is more descriptive
                    if record_value in columns[column_id]['values']:
                        record_value = columns[column_id]['values'][record_value]['caption']

                # strip newlines and carriage returns from the value to avoid issues with the csv format
                csv_data[table_name] += f"{record_value}".replace("\n", ", ").replace(";", ",") + ";"
            
            csv_data[table_name] = csv_data[table_name].rstrip(";")  # remove the last ";" from the line
            csv_data[table_name] += "\n"

            # update progress bar
            bar()

    # here we create a csv file for each table and write the corresponding data to it
    for table_name, csv in csv_data.items():
        with open(f"csv/{table_name}.csv", 'w', encoding="utf-8") as f:
            f.write(csv.rstrip())  # remove the last newline from the csv data

if __name__ == "__main__":    
    main()